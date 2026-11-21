package com.example.dragonalpha.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.dragonalpha.model.*
import com.example.dragonalpha.repository.AuthRepository
import com.example.dragonalpha.repository.MockWalletRepository
import com.example.dragonalpha.repository.WalletRepository
import com.example.dragonalpha.sound.SoundManager
import io.socket.client.IO
import io.socket.client.Socket
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.URISyntaxException

data class ColorPredictionUiState(
    val status: GameStatus = GameStatus.WAITING,
    val timeLeft: Int = 0,
    val roundId: String = "SYNCING...",
    val activeBets: Map<PredictionColor, Double> = emptyMap(),
    val selectedChipAmount: Double = 50.0,
    val totalBetAmount: Double = 0.0,
    val winningColor: PredictionColor? = null,
    val history: List<RoundResult> = emptyList(),
    val isWin: Boolean = false,
    val balance: Double = 0.0,
    val errorMessage: String? = null
)

class ColorPredictionViewModel(
    private val walletRepository: WalletRepository,
    private val authRepository: AuthRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(ColorPredictionUiState())
    val uiState: StateFlow<ColorPredictionUiState> = _uiState.asStateFlow()

    private var socket: Socket? = null
    private val SOCKET_URL = "https://dragon-server-0y5z.onrender.com"

    private var isScreenActive = false
    private var currentUserId: String = ""

    init {
        observeCurrentUser()
        observeWalletBalance()
        setupSocket()
    }

    private fun resolveUserId(): String {
        val candidates = listOf(
            currentUserId,
            MockWalletRepository.activeUserId.orEmpty(),
            MockWalletRepository.activePhone.orEmpty()
        )
        return candidates
            .map { it.trim() }
            .firstOrNull {
                it.isNotBlank() &&
                    !it.equals("GUEST_USER", ignoreCase = true) &&
                    !it.startsWith("11111111")
            }
            .orEmpty()
    }

    private fun observeCurrentUser() {
        viewModelScope.launch {
            authRepository.currentUser.collect { user ->
                if (user != null && user.uid.isNotBlank()) {
                    currentUserId = user.uid
                    refreshBalance()
                }
            }
        }
    }

    fun refreshBalance() {
        val uid = resolveUserId()
        if (uid.isNotBlank()) {
            walletRepository.refreshBalance(uid)
        }
    }

    private fun observeWalletBalance() {
        viewModelScope.launch {
            walletRepository.getBalance().collect { balance ->
                _uiState.update { it.copy(balance = balance) }
            }
        }
    }

    private fun setupSocket() {
        try {
            val opts = IO.Options().apply {
                transports = arrayOf("websocket")
                reconnection = true
            }
            socket = IO.socket(SOCKET_URL, opts)

            socket?.on(Socket.EVENT_CONNECT) {
                val uid = resolveUserId()
                val joinData = JSONObject().apply {
                    put("userId", uid)
                }
                socket?.emit("join_color_game", joinData)
                refreshBalance()
            }

            socket?.on("wallet_updated") { args ->
                val data = args.getOrNull(0) as? JSONObject ?: return@on
                val targetUserId = data.optString("userId", "").trim()
                val myId = resolveUserId()
                if (targetUserId.isEmpty() || targetUserId == myId || targetUserId == MockWalletRepository.activeUserId) {
                    val newBal = when {
                        data.has("balance") -> data.optDouble("balance")
                        data.has("newBalance") -> data.optDouble("newBalance")
                        else -> null
                    }
                    if (newBal != null) {
                        walletRepository.updateBalance(newBal)
                        _uiState.update { it.copy(balance = newBal) }
                    }
                }
            }

            socket?.on("color_bet_accepted") { args ->
                val data = args.getOrNull(0) as? JSONObject ?: return@on
                val colorStr = data.optString("color", "")
                val amt = data.optDouble("amount", 0.0)
                val newBal = if (data.has("balance")) data.optDouble("balance") else null

                if (newBal != null) {
                    walletRepository.updateBalance(newBal)
                }

                if (amt > 0 && colorStr.isNotBlank()) {
                    val color = PredictionColor.fromString(colorStr.uppercase())
                    if (isScreenActive) SoundManager.playCoinBet()

                    _uiState.update { state ->
                        val updatedBets = state.activeBets.toMutableMap().apply {
                            put(color, (this[color] ?: 0.0) + amt)
                        }
                        state.copy(
                            activeBets = updatedBets,
                            totalBetAmount = state.totalBetAmount + amt,
                            balance = newBal ?: state.balance,
                            errorMessage = null
                        )
                    }
                }
            }

            socket?.on("bet_error") { args ->
                val data = args.getOrNull(0) as? JSONObject
                val msg = data?.optString("message", "Bet failed") ?: "Bet failed"
                _uiState.update { it.copy(errorMessage = msg) }
                refreshBalance()
            }

            val winListener = { args: Array<Any> ->
                val data = args.getOrNull(0) as? JSONObject
                if (data != null) {
                    val targetUserId = data.optString("userId", "").trim()
                    val myId = resolveUserId()
                    if (targetUserId.isEmpty() || targetUserId == myId || targetUserId == MockWalletRepository.activeUserId) {
                        if (data.has("balance")) {
                            val newBal = data.optDouble("balance")
                            walletRepository.updateBalance(newBal)
                            _uiState.update { it.copy(balance = newBal) }
                        } else {
                            refreshBalance()
                        }
                    }
                }
            }
            socket?.on("color_bet_won") { args -> winListener(args) }
            socket?.on("bet_won") { args -> winListener(args) }

            val tickListener = { args: Array<Any> ->
                val data = args.getOrNull(0) as? JSONObject
                if (data != null) {
                    val roundId = data.optString("roundId", "")
                    val timeLeft = data.optInt("timeLeft", 0)
                    val phase = data.optString("phase", "BETTING").uppercase()

                    _uiState.update { state ->
                        val isNewRound = roundId.isNotBlank() && state.roundId != roundId
                        val status = when {
                            phase == "RESULT" || timeLeft <= 0 -> GameStatus.RESULT
                            timeLeft <= 5 -> GameStatus.LOCKED
                            else -> GameStatus.BETTING
                        }
                        state.copy(
                            roundId = if (roundId.isNotBlank()) "CP-$roundId" else state.roundId,
                            timeLeft = timeLeft,
                            status = status,
                            activeBets = if (isNewRound) emptyMap() else state.activeBets,
                            totalBetAmount = if (isNewRound) 0.0 else state.totalBetAmount,
                            winningColor = if (isNewRound) null else state.winningColor,
                            isWin = if (isNewRound) false else state.isWin
                        )
                    }

                    if (timeLeft in 1..5 && isScreenActive) {
                        SoundManager.playCountdownTick()
                    }
                    if (timeLeft == 5 && isScreenActive) {
                        SoundManager.playRoundLocked()
                    }
                }
            }
            socket?.on("color_timer_tick") { args -> tickListener(args) }
            socket?.on("color_game_tick") { args -> tickListener(args) }

            socket?.on("color_round_result") { args ->
                val data = args.getOrNull(0) as? JSONObject ?: return@on
                val winningColorStr = data.optString("winningColor", "RED")
                val winningColor = PredictionColor.fromString(winningColorStr.uppercase())

                val activeBets = _uiState.value.activeBets
                val isWin = activeBets.containsKey(winningColor)
                val mult = if (winningColor == PredictionColor.VIOLET) 4.5 else 2.0
                val winAmount = (activeBets[winningColor] ?: 0.0) * mult

                if (isScreenActive) {
                    SoundManager.playResultReveal()
                    if (isWin) SoundManager.playWinEffect()
                }

                _uiState.update {
                    it.copy(
                        timeLeft = 0,
                        status = GameStatus.RESULT,
                        winningColor = winningColor,
                        isWin = isWin
                    )
                }

                addToHistory(_uiState.value.roundId, winningColor, activeBets, isWin, winAmount)

                // Safety sync with Supabase 1s after settlement
                viewModelScope.launch {
                    delay(1000)
                    refreshBalance()
                }
            }
        } catch (e: URISyntaxException) {
            e.printStackTrace()
        }
    }

    fun onScreenStarted() {
        isScreenActive = true
        refreshBalance()
        try {
            if (socket?.connected() != true) {
                socket?.connect()
            } else {
                socket?.emit("join_color_game", JSONObject().apply { put("userId", resolveUserId()) })
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    fun onScreenStopped() {
        isScreenActive = false
        try {
            socket?.disconnect()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    fun selectChipAmount(amount: Double) {
        if (isScreenActive) {
            SoundManager.playButtonClick()
        }
        _uiState.update { it.copy(selectedChipAmount = amount) }
    }

    fun selectColor(color: PredictionColor) {
        if (_uiState.value.status != GameStatus.BETTING) return

        val amount = _uiState.value.selectedChipAmount
        if (_uiState.value.balance < amount) {
            _uiState.update { it.copy(errorMessage = "Insufficient wallet balance!") }
            return
        }

        if (socket?.connected() != true) {
            socket?.connect()
            _uiState.update { it.copy(errorMessage = "Live server se connect ho raha hai, 2 sec baad try karein.") }
            return
        }

        viewModelScope.launch {
            val authUser = authRepository.currentUser.firstOrNull()
            val userId = authUser?.uid?.takeIf { it.isNotBlank() && !it.startsWith("11111111") }
                ?: resolveUserId()

            if (userId.isBlank()) {
                _uiState.update { it.copy(errorMessage = "Session missing. Kripya dobara login karein.") }
                return@launch
            }

            val choice = when (color) {
                PredictionColor.RED -> "RED"
                PredictionColor.GREEN -> "GREEN"
                PredictionColor.VIOLET -> "VIOLET"
            }

            val betData = JSONObject().apply {
                put("color", choice)
                put("amount", amount)
                put("userId", userId)
            }
            try {
                socket?.emit("color_place_bet", betData)
            } catch (e: Exception) {
                _uiState.update { it.copy(errorMessage = "Bet send failed: ${e.message}") }
            }
        }
    }

    private fun addToHistory(
        roundId: String,
        winningColor: PredictionColor,
        userBets: Map<PredictionColor, Double>,
        isWin: Boolean,
        winAmount: Double
    ) {
        val totalBetAmount = userBets.values.sum()
        val netAmount = if (isWin) winAmount - totalBetAmount else -totalBetAmount

        val result = RoundResult(
            roundId = roundId,
            winningColor = winningColor,
            userBets = userBets,
            totalWinAmount = netAmount,
            isWin = isWin
        )
        _uiState.update {
            it.copy(history = (listOf(result) + it.history).take(30))
        }
    }

    fun clearError() {
        _uiState.update { it.copy(errorMessage = null) }
    }

    override fun onCleared() {
        super.onCleared()
        try {
            socket?.disconnect()
            socket?.off()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}

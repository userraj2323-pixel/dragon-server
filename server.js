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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URISyntaxException
import java.net.URL

typealias BetMap = Map<BetType, Int>

class DragonVsTigerViewModel(
    private val walletRepository: WalletRepository,
    private val authRepository: AuthRepository
) : ViewModel() {

    private val SERVER_URL = "https://dragon-server-0y5z.onrender.com"

    private val _gamePhase = MutableStateFlow(DVTGamePhase.BETTING)
    val gamePhase: StateFlow<DVTGamePhase> = _gamePhase.asStateFlow()

    private val _timeRemaining = MutableStateFlow(20)
    val timeRemaining: StateFlow<Int> = _timeRemaining.asStateFlow()

    private val _roundId = MutableStateFlow("SYNCING...")
    val roundId: StateFlow<String> = _roundId.asStateFlow()

    private val _selectedChip = MutableStateFlow(100)
    val selectedChip: StateFlow<Int> = _selectedChip.asStateFlow()

    private val _userBets = MutableStateFlow<BetMap>(emptyMap())
    val userBets: StateFlow<BetMap> = _userBets.asStateFlow()

    private var lastUserBets: BetMap = emptyMap()

    private val _totalZoneBets = MutableStateFlow<BetMap>(
        BetType.allBets.associateWith { 0 }
    )
    val totalZoneBets: StateFlow<BetMap> = _totalZoneBets.asStateFlow()

    private val _dragonCard = MutableStateFlow<PlayingCard?>(null)
    val dragonCard: StateFlow<PlayingCard?> = _dragonCard.asStateFlow()

    private val _tigerCard = MutableStateFlow<PlayingCard?>(null)
    val tigerCard: StateFlow<PlayingCard?> = _tigerCard.asStateFlow()

    private val _lastResult = MutableStateFlow<DVTRoundResult?>(null)
    val lastResult: StateFlow<DVTRoundResult?> = _lastResult.asStateFlow()

    private val _lastPayoutAmount = MutableStateFlow(0)
    val lastPayoutAmount: StateFlow<Int> = _lastPayoutAmount.asStateFlow()

    private val _history = MutableStateFlow<List<DVTRoundResult>>(emptyList())
    val history: StateFlow<List<DVTRoundResult>> = _history.asStateFlow()

    private val _balance = MutableStateFlow(0.0)
    val balance: StateFlow<Double> = _balance.asStateFlow()

    private val _chipEvents = MutableSharedFlow<DVTChipAnimation>(extraBufferCapacity = 64)
    val chipEvents: SharedFlow<DVTChipAnimation> = _chipEvents.asSharedFlow()

    private val _showWinEffect = MutableStateFlow(false)
    val showWinEffect: StateFlow<Boolean> = _showWinEffect.asStateFlow()

    private var isScreenActive = false
    private var mSocket: Socket? = null
    private var lastSocketTickTime = 0L
    private var syncJob: Job? = null
    private var settledRoundId: String? = null

    fun onScreenResume() {
        isScreenActive = true
        refreshBalance()
        try {
            if (mSocket?.connected() != true) {
                mSocket?.connect()
            }
        } catch (_: Exception) {}
    }

    fun onScreenPause() {
        isScreenActive = false
    }

    init {
        observeWalletBalance()
        refreshBalance()
        connectToSocketServer()
        startLiveHttpSyncLoop()
    }

    private suspend fun resolveUserId(): String {
        val authUid = authRepository.currentUser.firstOrNull()?.uid.orEmpty()
        return listOf(
            authUid,
            MockWalletRepository.activeUserId.orEmpty(),
            MockWalletRepository.activePhone.orEmpty()
        ).map { it.trim() }.firstOrNull {
            it.isNotBlank() && !it.equals("GUEST", true) && !it.equals("GUEST_USER", true) && !it.startsWith("11111111")
        }.orEmpty()
    }

    private fun refreshBalance() {
        viewModelScope.launch {
            val uid = resolveUserId()
            if (uid.isNotBlank()) {
                walletRepository.refreshBalance(uid)
            }
        }
    }

    private fun observeWalletBalance() {
        viewModelScope.launch {
            walletRepository.getBalance().collect { bal ->
                _balance.value = bal
            }
        }
    }

    private fun connectToSocketServer() {
        try {
            val opts = IO.Options().apply {
                transports = arrayOf("polling", "websocket")
                upgrade = true
                reconnection = true
            }
            mSocket = IO.socket(SERVER_URL, opts)
            setupSocketEvents()
            mSocket?.connect()
        } catch (e: URISyntaxException) {
            e.printStackTrace()
        }
    }

    private fun setupSocketEvents() {
        mSocket?.on("round_start") { args ->
            if (args.isNotEmpty()) {
                lastSocketTickTime = System.currentTimeMillis()
                val data = args[0] as? JSONObject ?: return@on
                val rId = data.optInt("roundId", 0)
                if (rId > 0) {
                    applyServerRoundStart("DVT-$rId")
                }
            }
        }

        mSocket?.on("timer_tick") { args ->
            if (args.isNotEmpty()) {
                lastSocketTickTime = System.currentTimeMillis()
                val data = args[0] as? JSONObject ?: return@on
                val timeLeft = data.optInt("timeLeft", 0)
                val state = data.optString("state", "BETTING")
                applyServerTick(timeLeft, state)
            }
        }

        mSocket?.on("round_result") { args ->
            if (args.isNotEmpty()) {
                lastSocketTickTime = System.currentTimeMillis()
                val data = args[0] as? JSONObject ?: return@on
                handleServerResultJson(data)
            }
        }
    }

    // 100% Reliable Live HTTP Sync (matches Admin Panel exact Round, Timer & Force Win)
    private fun startLiveHttpSyncLoop() {
        syncJob?.cancel()
        syncJob = viewModelScope.launch {
            while (true) {
                if (isScreenActive && System.currentTimeMillis() - lastSocketTickTime > 2500) {
                    val stateJson = fetchServerDvtState()
                    if (stateJson != null && stateJson.optBoolean("success", false)) {
                        val rawRoundId = stateJson.optInt("roundId", 0)
                        val timeLeft = stateJson.optInt("timeLeft", 0)
                        val phase = stateJson.optString("phase", "BETTING").uppercase()
                        val fullRoundId = if (rawRoundId > 0) "DVT-$rawRoundId" else _roundId.value

                        if (rawRoundId > 0 && _roundId.value != fullRoundId) {
                            applyServerRoundStart(fullRoundId)
                        }

                        if (phase == "RESULT") {
                            val resObj = stateJson.optJSONObject("result")
                            if (resObj != null) {
                                handleServerResultJson(resObj)
                            }
                        } else {
                            applyServerTick(timeLeft, phase)
                        }
                    }
                }
                delay(1000)
            }
        }
    }

    private suspend fun fetchServerDvtState(): JSONObject? = withContext(Dispatchers.IO) {
        try {
            val url = URL("$SERVER_URL/api/game/dvt-state")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                useCaches = false
                connectTimeout = 5000
                readTimeout = 5000
            }
            val code = conn.responseCode
            val text = if (code in 200..299) conn.inputStream.bufferedReader().use { it.readText() } else ""
            conn.disconnect()
            if (text.isNotBlank()) JSONObject(text) else null
        } catch (_: Exception) {
            null
        }
    }

    private suspend fun notifyServerDvtBetHttp(betOn: String, amount: Int) = withContext(Dispatchers.IO) {
        try {
            val url = URL("$SERVER_URL/api/game/dvt-bet")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                doOutput = true
                connectTimeout = 5000
                readTimeout = 5000
            }
            val body = JSONObject().apply {
                put("bet_on", betOn)
                put("amount", amount)
            }
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            conn.responseCode
            conn.disconnect()
        } catch (_: Exception) {}
    }

    private fun applyServerRoundStart(fullRoundId: String) {
        _roundId.value = fullRoundId
        _gamePhase.value = DVTGamePhase.BETTING
        _dragonCard.value = null
        _tigerCard.value = null
        _showWinEffect.value = false
        _lastPayoutAmount.value = 0
        _totalZoneBets.value = BetType.allBets.associateWith { 0 }
    }

    private fun applyServerTick(timeLeft: Int, state: String) {
        _timeRemaining.value = timeLeft
        if (state.equals("BETTING", ignoreCase = true) && timeLeft > 0) {
            if (_gamePhase.value != DVTGamePhase.BETTING) {
                _gamePhase.value = DVTGamePhase.BETTING
            }
            if (isScreenActive && timeLeft in 1..5) {
                SoundManager.playCountdownTick()
            }
        } else {
            if (_gamePhase.value == DVTGamePhase.BETTING && isScreenActive) {
                SoundManager.playRoundLocked()
            }
        }
    }

    private fun handleServerResultJson(data: JSONObject) {
        val rId = data.optInt("roundId", 0)
        val fullRoundId = if (rId > 0) "DVT-$rId" else _roundId.value
        if (settledRoundId == fullRoundId) return
        settledRoundId = fullRoundId

        val dCardVal = data.optInt("dCard", 7)
        val tCardVal = data.optInt("tCard", 7)
        val winnerStr = data.optString("winner", "DRAGON")

        val winType = when {
            winnerStr.equals("DRAGON", ignoreCase = true) -> WinnerType.DRAGON
            winnerStr.equals("TIGER", ignoreCase = true) -> WinnerType.TIGER
            else -> WinnerType.TIE
        }

        val dRank = CardRank.entries.find { it.ordinal + 1 == dCardVal } ?: CardRank.SEVEN
        val tRank = CardRank.entries.find { it.ordinal + 1 == tCardVal } ?: CardRank.SEVEN

        val dCard = PlayingCard(CardSuit.SPADES, dRank)
        val tCard = PlayingCard(CardSuit.HEARTS, tRank)

        viewModelScope.launch {
            runRevealAndPayout(fullRoundId, winType, dCard, tCard)
        }
    }

    private suspend fun runRevealAndPayout(
        roundId: String,
        winType: WinnerType,
        dCard: PlayingCard,
        tCard: PlayingCard
    ) {
        _timeRemaining.value = 0
        _gamePhase.value = DVTGamePhase.DEALING
        _dragonCard.value = dCard
        _tigerCard.value = tCard
        delay(500)

        _gamePhase.value = DVTGamePhase.REVEAL_DRAGON
        if (isScreenActive) SoundManager.playResultReveal()
        delay(800)

        _gamePhase.value = DVTGamePhase.REVEAL_TIGER
        if (isScreenActive) SoundManager.playResultReveal()
        delay(800)

        _gamePhase.value = DVTGamePhase.EVALUATION
        val result = DVTRoundResult(
            roundId = roundId,
            winner = winType,
            dragonCard = dCard,
            tigerCard = tCard
        )
        _lastResult.value = result

        if (isScreenActive) {
            when (winType) {
                WinnerType.DRAGON -> SoundManager.playDragonRoar()
                WinnerType.TIGER -> SoundManager.playTigerRoar()
                else -> {}
            }
        }

        val newHistory = _history.value.toMutableList()
        newHistory.add(result)
        if (newHistory.size > 30) newHistory.removeAt(0)
        _history.value = newHistory
        delay(600)

        _gamePhase.value = DVTGamePhase.PAYOUT
        calculatePayout(result)
    }

    private suspend fun calculatePayout(result: DVTRoundResult) {
        val currentBets = _userBets.value
        var totalWin = 0.0
        var totalStaked = 0.0

        for (entry in currentBets) {
            val bet = entry.key
            val amount = entry.value
            totalStaked += amount
            val isWin = evaluateBet(bet, result)
            val multiplier = when (bet) {
                BetType.Dragon, BetType.Tiger -> 1.0
                BetType.Tie -> 8.0
                else -> 1.0
            }
            if (isWin) {
                totalWin += amount + (amount * multiplier)
            } else if (result.winner == WinnerType.TIE && (bet == BetType.Dragon || bet == BetType.Tiger)) {
                totalWin += amount * 0.5
            }
        }

        _lastPayoutAmount.value = totalWin.toInt()

        if (totalWin > 0) {
            val uid = resolveUserId()
            if (uid.isNotBlank()) {
                walletRepository.processTransaction(
                    userId = uid,
                    amount = totalWin,
                    type = TransactionType.WIN,
                    referenceId = "DVT-WIN-${_roundId.value}"
                )
            }

            if (totalWin > totalStaked && isScreenActive) {
                _showWinEffect.value = true
                SoundManager.playWinEffect()
            }
        }

        lastUserBets = currentBets
        _userBets.value = emptyMap()
    }

    private fun evaluateBet(bet: BetType, result: DVTRoundResult): Boolean {
        return when (bet) {
            BetType.Dragon -> result.winner == WinnerType.DRAGON
            BetType.Tiger -> result.winner == WinnerType.TIGER
            BetType.Tie -> result.winner == WinnerType.TIE
            else -> false
        }
    }

    fun selectChip(amount: Int) {
        _selectedChip.value = amount
        if (isScreenActive) {
            SoundManager.playCoinBet()
        }
    }

    // Instant Bet (0ms UI lag + Background Supabase Sync)
    fun placeBet(betType: BetType, startX: Float = 0.5f, startY: Float = 0.8f) {
        if (_gamePhase.value != DVTGamePhase.BETTING) return
        val chipVal = _selectedChip.value
        if (_balance.value < chipVal) return

        val betOnStr = when (betType) {
            BetType.Dragon -> "DRAGON"
            BetType.Tiger -> "TIGER"
            BetType.Tie -> "TIE"
            else -> null
        }

        // 1. Instant UI Update + Chip Animation + Sound
        _balance.value = (_balance.value - chipVal).coerceAtLeast(0.0)

        val userMap = _userBets.value.toMutableMap()
        userMap[betType] = (userMap[betType] ?: 0) + chipVal
        _userBets.value = userMap

        val totalMap = _totalZoneBets.value.toMutableMap()
        totalMap[betType] = (totalMap[betType] ?: 0) + chipVal
        _totalZoneBets.value = totalMap

        _chipEvents.tryEmit(
            DVTChipAnimation(
                amount = chipVal,
                startX = startX,
                startY = startY,
                targetBetType = betType
            )
        )
        if (isScreenActive) SoundManager.playChipPlace()

        // 2. Background Supabase Deduction + Admin Panel Live Bet Sync
        val currentRound = _roundId.value
        viewModelScope.launch {
            val uid = resolveUserId()
            if (uid.isBlank()) {
                revertLocalBet(betType, chipVal)
                return@launch
            }

            val result = walletRepository.processTransaction(
                userId = uid,
                amount = chipVal.toDouble(),
                type = TransactionType.BET,
                referenceId = "DVT-BET-$currentRound"
            )

            if (result.isSuccess) {
                if (betOnStr != null) {
                    notifyServerDvtBetHttp(betOnStr, chipVal)
                    try {
                        val jsonObject = JSONObject().apply {
                            put("bet_on", betOnStr)
                            put("amount", chipVal)
                            put("userId", uid)
                        }
                        mSocket?.emit("place_bet", jsonObject)
                    } catch (_: Exception) {}
                }
            } else {
                revertLocalBet(betType, chipVal)
            }
        }
    }

    private fun revertLocalBet(betType: BetType, amount: Int) {
        val userMap = _userBets.value.toMutableMap()
        val updatedUserAmt = ((userMap[betType] ?: 0) - amount).coerceAtLeast(0)
        if (updatedUserAmt <= 0) userMap.remove(betType) else userMap[betType] = updatedUserAmt
        _userBets.value = userMap

        val totalMap = _totalZoneBets.value.toMutableMap()
        totalMap[betType] = ((totalMap[betType] ?: 0) - amount).coerceAtLeast(0)
        _totalZoneBets.value = totalMap

        refreshBalance()
    }

    fun clearBets() {
        if (_gamePhase.value != DVTGamePhase.BETTING) return
        val currentBets = _userBets.value
        if (currentBets.isEmpty()) return

        val totalRefund = currentBets.values.sum().toDouble()
        viewModelScope.launch {
            val uid = resolveUserId()
            if (uid.isBlank()) return@launch

            walletRepository.processTransaction(
                userId = uid,
                amount = totalRefund,
                type = TransactionType.WIN,
                referenceId = "DVT-CLEAR-REFUND"
            )

            val totalMap = _totalZoneBets.value.toMutableMap()
            for (entry in currentBets) {
                val bet = entry.key
                val amt = entry.value
                totalMap[bet] = ((totalMap[bet] ?: 0) - amt).coerceAtLeast(0)
            }
            _totalZoneBets.value = totalMap
            _userBets.value = emptyMap()

            if (isScreenActive) {
                SoundManager.playCoinBet()
            }
        }
    }

    fun doubleBets() {
        if (_gamePhase.value != DVTGamePhase.BETTING) return
        val currentBets = _userBets.value
        if (currentBets.isEmpty()) return

        val totalAdditionalStaked = currentBets.values.sum().toDouble()
        if (_balance.value < totalAdditionalStaked) return

        viewModelScope.launch {
            val uid = resolveUserId()
            if (uid.isBlank()) return@launch

            val result = walletRepository.processTransaction(
                userId = uid,
                amount = totalAdditionalStaked,
                type = TransactionType.BET,
                referenceId = "DVT-DOUBLE-BET"
            )

            if (result.isSuccess) {
                val newBets = currentBets.mapValues { it.value * 2 }
                val totalMap = _totalZoneBets.value.toMutableMap()
                for (entry in currentBets) {
                    val bet = entry.key
                    val amt = entry.value
                    totalMap[bet] = (totalMap[bet] ?: 0) + amt
                    val betOnStr = when (bet) {
                        BetType.Dragon -> "DRAGON"
                        BetType.Tiger -> "TIGER"
                        BetType.Tie -> "TIE"
                        else -> null
                    }
                    if (betOnStr != null) notifyServerDvtBetHttp(betOnStr, amt)
                }
                _totalZoneBets.value = totalMap
                _userBets.value = newBets

                if (isScreenActive) {
                    SoundManager.playCoinBet()
                }
            }
        }
    }

    fun repeatBets() {
        if (_gamePhase.value != DVTGamePhase.BETTING) return
        if (lastUserBets.isEmpty()) return

        val neededBalance = lastUserBets.values.sum().toDouble()
        if (_balance.value < neededBalance) return

        viewModelScope.launch {
            val uid = resolveUserId()
            if (uid.isBlank()) return@launch

            val result = walletRepository.processTransaction(
                userId = uid,
                amount = neededBalance,
                type = TransactionType.BET,
                referenceId = "DVT-REPEAT-BET"
            )

            if (result.isSuccess) {
                val userMap = _userBets.value.toMutableMap()
                val totalMap = _totalZoneBets.value.toMutableMap()

                for (entry in lastUserBets) {
                    val bet = entry.key
                    val amt = entry.value
                    userMap[bet] = (userMap[bet] ?: 0) + amt
                    totalMap[bet] = (totalMap[bet] ?: 0) + amt
                    val betOnStr = when (bet) {
                        BetType.Dragon -> "DRAGON"
                        BetType.Tiger -> "TIGER"
                        BetType.Tie -> "TIE"
                        else -> null
                    }
                    if (betOnStr != null) notifyServerDvtBetHttp(betOnStr, amt)
                }

                _userBets.value = userMap
                _totalZoneBets.value = totalMap

                if (isScreenActive) {
                    SoundManager.playCoinBet()
                }
            }
        }
    }

    override fun onCleared() {
        super.onCleared()
        syncJob?.cancel()
        mSocket?.disconnect()
        mSocket?.off()
    }
}

package io.github.mitzacoder.kemiri.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.distinctUntilChangedBy
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.shareIn

/** One foreground time source. Slower labels subscribe to a coarser bucket of the same ticks. */
private object AppClock {
    val ticks = flow {
        while (true) {
            val now = System.currentTimeMillis()
            emit(now)
            delay(1000L - Math.floorMod(now, 1000L))
        }
    }.shareIn(CoroutineScope(SupervisorJob() + Dispatchers.Default), SharingStarted.WhileSubscribed(replayExpirationMillis = 0), replay = 1)
}

@Composable
internal fun rememberAppTime(periodMs: Long = 30_000L, active: Boolean = true): Long {
    if (!active) return remember { System.currentTimeMillis() }
    val times = remember(periodMs) { AppClock.ticks.distinctUntilChangedBy { it / periodMs } }
    return times.collectAsStateWithLifecycle(initialValue = remember { System.currentTimeMillis() }).value
}

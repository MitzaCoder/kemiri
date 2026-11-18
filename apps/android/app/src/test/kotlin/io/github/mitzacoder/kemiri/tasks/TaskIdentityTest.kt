package io.github.mitzacoder.kemiri.tasks

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import io.github.mitzacoder.kemiri.data.ThemePalette
import io.github.mitzacoder.kemiri.features.tasks.isTaskSelfReference
import io.github.mitzacoder.kemiri.features.tasks.taskIdForeground
import io.github.mitzacoder.kemiri.features.tasks.taskIdentityAccent
import io.github.mitzacoder.kemiri.features.tasks.taskReferenceMatches
import io.github.mitzacoder.kemiri.ui.theme.harnessColors
import org.junit.Assert.*
import org.junit.Test
import kotlin.math.max
import kotlin.math.min

class TaskIdentityTest {
    @Test fun onlyAValidMentionOfTheOpenTaskIsASelfReference() {
        assertTrue(isTaskSelfReference("T63", "T63"))
        assertTrue(isTaskSelfReference("T1298", "T1298"))
        assertFalse(isTaskSelfReference("T63", "T630"))
        assertFalse(isTaskSelfReference("T63", null))
        assertFalse(isTaskSelfReference("63", "63"))
    }

    @Test fun onlyThePreviewedTaskMatchesAndDismissalClearsIt() {
        assertTrue(taskReferenceMatches("T12", "T12"))
        assertFalse(taskReferenceMatches("T13", "T12"))
        assertFalse(taskReferenceMatches("T12", null))
        assertFalse(taskReferenceMatches("T1", "T12"))
    }

    @Test fun chipsMeetAAOnEveryCollapsedSurfaceInBothPalettesAndThemes() {
        ThemePalette.entries.forEach { palette -> listOf(false, true).forEach { dark ->
            val colors = harnessColors(palette, dark)
            val foreground = taskIdForeground(colors)
            val accent = taskIdentityAccent(colors)
            val surfaces = listOf(colors.bg, colors.surface, colors.surface2,
                accent.copy(alpha = .09f).compositeOver(colors.bg),
                colors.warning.copy(alpha = .09f).compositeOver(colors.bg))
            surfaces.forEach { surface ->
                val fill = accent.copy(alpha = .12f).compositeOver(surface)
                val a = foreground.luminance().toDouble(); val b = fill.luminance().toDouble()
                val contrast = (max(a, b) + .05) / (min(a, b) + .05)
                assertTrue("$palette dark=$dark contrast=$contrast", contrast >= 4.5)
            }
            if (palette == ThemePalette.Neutral) {
                assertEquals(foreground.red, foreground.green, .00001f)
                assertEquals(accent.red, accent.blue, .00001f)
            }
        } }
    }

    @Test fun jarvisIdentityPairsMatchWeb() {
        assertEquals(Color(0xFF4338CA), taskIdForeground(harnessColors(ThemePalette.Jarvis, false)))
        assertEquals(Color(0xFFC7D2FE), taskIdForeground(harnessColors(ThemePalette.Jarvis, true)))
        assertEquals(Color(0xFF818CF8), taskIdentityAccent(harnessColors(ThemePalette.Jarvis, true)))
    }
}

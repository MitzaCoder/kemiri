package io.github.mitzacoder.kemiri.theme

import androidx.compose.ui.graphics.luminance
import io.github.mitzacoder.kemiri.navigation.headerPanelPalette
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.max
import kotlin.math.min

class HeaderPanelPaletteTest {
    @Test fun selectedPanelTextAndIconsMeetAAInBothThemesAndModes() {
        for (dark in listOf(false, true)) for (neutral in listOf(false, true)) {
            val palette = headerPanelPalette(dark, neutral)
            val foreground = palette.foreground.luminance().toDouble()
            val background = palette.background.luminance().toDouble()
            val contrast = (max(foreground, background) + .05) / (min(foreground, background) + .05)
            assertTrue("dark=$dark neutral=$neutral contrast=$contrast", contrast >= 4.5)
        }
    }

    @Test fun neutralPanelSelectionStaysAchromatic() {
        for (dark in listOf(false, true)) {
            val palette = headerPanelPalette(dark, neutral = true)
            for (color in listOf(palette.foreground, palette.background)) {
                assertTrue(color.red == color.green && color.green == color.blue)
            }
        }
    }
}

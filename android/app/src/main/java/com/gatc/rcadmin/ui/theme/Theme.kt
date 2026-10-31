package com.gatc.rcadmin.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp

private val GatcColorScheme = lightColorScheme(
    primary = PrimaryBlue,
    onPrimary = CardBackground,
    primaryContainer = SoftBlue,
    onPrimaryContainer = PrimaryBlueDark,
    secondary = Navy,
    onSecondary = CardBackground,
    background = ScreenBackground,
    onBackground = TextInk,
    surface = CardBackground,
    onSurface = TextInk,
    surfaceVariant = SoftBlue,
    onSurfaceVariant = MutedText,
    outline = Border,
    error = WarningAmber,
)

private val GatcShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(18.dp),
    extraLarge = RoundedCornerShape(24.dp),
)

@Composable
fun GatcRcAdminTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = GatcColorScheme,
        typography = GatcTypography,
        shapes = GatcShapes,
        content = content,
    )
}

package com.gatc.rcadmin

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.material3.windowsizeclass.WindowSizeClass
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import com.gatc.rcadmin.ui.navigation.RcAdminApp
import com.gatc.rcadmin.ui.theme.GatcRcAdminTheme

class MainActivity : ComponentActivity() {
    @OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            GatcRcAdminTheme {
                val windowSizeClass = calculateWindowSizeClass(this)
                RcAdminApp(windowSizeClass = windowSizeClass)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
@Preview(name = "Phone", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun PhoneAppPreview() {
    GatcRcAdminTheme {
        RcAdminApp(
            windowSizeClass = WindowSizeClass.calculateFromSize(DpSize(390.dp, 844.dp)),
        )
    }
}

@OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
@Preview(name = "Tablet", showBackground = true, widthDp = 900, heightDp = 700)
@Composable
fun TabletAppPreview() {
    GatcRcAdminTheme {
        RcAdminApp(
            windowSizeClass = WindowSizeClass.calculateFromSize(DpSize(900.dp, 700.dp)),
        )
    }
}

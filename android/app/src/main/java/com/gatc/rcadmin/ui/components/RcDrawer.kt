package com.gatc.rcadmin.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.LocalShipping
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Science
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.ShoppingBag
import androidx.compose.material.icons.outlined.FactCheck
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Apartment
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.gatc.rcadmin.ui.navigation.Destinations
import com.gatc.rcadmin.ui.theme.Border
import com.gatc.rcadmin.ui.theme.CardBackground
import com.gatc.rcadmin.ui.theme.MutedText
import com.gatc.rcadmin.ui.theme.PrimaryBlue
import com.gatc.rcadmin.ui.theme.ScreenBackground
import com.gatc.rcadmin.ui.theme.SoftBlue
import com.gatc.rcadmin.ui.theme.TextInk

private data class NavEntry(
    val destination: Destinations,
    val icon: ImageVector,
)

@Composable
fun RcDrawerContent(
    selectedRoute: String,
    onNavigate: (Destinations) -> Unit,
    modifier: Modifier = Modifier,
) {
    var settingsExpanded by rememberSaveable { mutableStateOf(true) }
    val workspace = listOf(
        NavEntry(Destinations.Dashboard, Icons.Outlined.Dashboard),
        NavEntry(Destinations.Verification, Icons.Outlined.FactCheck),
        NavEntry(Destinations.Customer, Icons.Outlined.People),
        NavEntry(Destinations.Product, Icons.Outlined.Inventory2),
        NavEntry(Destinations.Purchases, Icons.Outlined.ShoppingBag),
    )
    val management = listOf(
        NavEntry(Destinations.Vct, Icons.Outlined.Groups),
        NavEntry(Destinations.Vehicle, Icons.Outlined.LocalShipping),
        NavEntry(Destinations.Laboratory, Icons.Outlined.Science),
    )

    Column(
        modifier = modifier
            .fillMaxHeight()
            .width(300.dp)
            .background(CardBackground)
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(PrimaryBlue),
                contentAlignment = Alignment.Center,
            ) {
                Text("⚖", color = CardBackground)
            }
            Spacer(Modifier.width(10.dp))
            GatcBrandMark(subtitle = "VERIFICATION SYSTEM", compact = true)
        }
        Spacer(Modifier.height(16.dp))
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(ScreenBackground)
                .border(1.dp, Border, RoundedCornerShape(12.dp))
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Outlined.Apartment, contentDescription = null, tint = PrimaryBlue)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text("RC Workspace", style = MaterialTheme.typography.titleMedium)
                Text("Regional Centre Admin", style = MaterialTheme.typography.bodySmall)
            }
            Icon(Icons.Outlined.ExpandMore, contentDescription = null, tint = MutedText)
        }
        Spacer(Modifier.height(20.dp))
        Text("WORKSPACE", style = MaterialTheme.typography.labelSmall, color = MutedText)
        Spacer(Modifier.height(8.dp))
        workspace.forEach { entry ->
            DrawerItem(
                label = entry.destination.title,
                icon = entry.icon,
                selected = selectedRoute == entry.destination.route ||
                    (entry.destination == Destinations.Verification &&
                        selectedRoute.startsWith("verification")),
                onClick = { onNavigate(entry.destination) },
            )
        }
        Spacer(Modifier.height(16.dp))
        Text("MANAGEMENT", style = MaterialTheme.typography.labelSmall, color = MutedText)
        Spacer(Modifier.height(8.dp))
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .clickable { settingsExpanded = !settingsExpanded }
                .padding(horizontal = 12.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Outlined.Settings, contentDescription = null, tint = TextInk)
            Spacer(Modifier.width(12.dp))
            Text("Settings", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
            Icon(
                if (settingsExpanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                contentDescription = if (settingsExpanded) "Collapse settings" else "Expand settings",
                tint = MutedText,
            )
        }
        AnimatedVisibility(visible = settingsExpanded) {
            Column(Modifier.padding(start = 8.dp)) {
                management.forEach { entry ->
                    DrawerItem(
                        label = entry.destination.title,
                        icon = entry.icon,
                        selected = selectedRoute == entry.destination.route,
                        onClick = { onNavigate(entry.destination) },
                    )
                }
            }
        }
        Spacer(Modifier.weight(1f))
        HorizontalDivider(color = Border)
        Spacer(Modifier.height(12.dp))
        DrawerItem(
            label = Destinations.Profile.title,
            icon = Icons.Outlined.Person,
            selected = selectedRoute == Destinations.Profile.route,
            onClick = { onNavigate(Destinations.Profile) },
        )
        Spacer(Modifier.height(12.dp))
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.padding(horizontal = 4.dp),
        ) {
            Box(
                Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(SoftBlue),
                contentAlignment = Alignment.Center,
            ) {
                Text("RC", color = PrimaryBlue, style = MaterialTheme.typography.labelLarge)
            }
            Column {
                Text("RC Administrator", style = MaterialTheme.typography.titleMedium)
                Text("Regional Centre", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun DrawerItem(
    label: String,
    icon: ImageVector,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val bg = if (selected) SoftBlue else CardBackground
    val tint = if (selected) PrimaryBlue else TextInk
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(bg)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = tint)
        Spacer(Modifier.width(12.dp))
        Text(
            label,
            style = MaterialTheme.typography.bodyLarge,
            color = tint,
            fontWeight = if (selected) androidx.compose.ui.text.font.FontWeight.SemiBold else androidx.compose.ui.text.font.FontWeight.Normal,
        )
    }
}

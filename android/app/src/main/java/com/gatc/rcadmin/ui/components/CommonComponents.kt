package com.gatc.rcadmin.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.gatc.rcadmin.data.model.AttentionItem
import com.gatc.rcadmin.data.model.AttentionKind
import com.gatc.rcadmin.data.model.JobType
import com.gatc.rcadmin.data.model.VerificationRecord
import com.gatc.rcadmin.data.model.VerificationUiStatus
import com.gatc.rcadmin.data.model.label
import com.gatc.rcadmin.ui.theme.Border
import com.gatc.rcadmin.ui.theme.CardBackground
import com.gatc.rcadmin.ui.theme.InfoSoft
import com.gatc.rcadmin.ui.theme.MutedText
import com.gatc.rcadmin.ui.theme.Navy
import com.gatc.rcadmin.ui.theme.PrimaryBlue
import com.gatc.rcadmin.ui.theme.PrimaryBlueDark
import com.gatc.rcadmin.ui.theme.SoftBlue
import com.gatc.rcadmin.ui.theme.SuccessGreen
import com.gatc.rcadmin.ui.theme.SuccessSoft
import com.gatc.rcadmin.ui.theme.TextInk
import com.gatc.rcadmin.ui.theme.WarningAmber
import com.gatc.rcadmin.ui.theme.WarningSoft

@Composable
fun GatcBrandMark(
    subtitle: String = "RC ADMIN WORKSPACE",
    compact: Boolean = false,
) {
    Column {
        Text(
            text = buildAnnotatedString {
                withStyle(SpanStyle(color = TextInk, fontWeight = FontWeight.Bold)) {
                    append("GATC")
                }
                withStyle(SpanStyle(color = PrimaryBlue, fontWeight = FontWeight.Bold)) {
                    append(".")
                }
            },
            style = if (compact) MaterialTheme.typography.titleLarge else MaterialTheme.typography.headlineMedium,
        )
        Text(
            text = subtitle,
            style = MaterialTheme.typography.labelSmall,
            color = MutedText,
        )
    }
}

@Composable
fun GatcTopBar(
    onMenuClick: (() -> Unit)?,
    onProfileClick: () -> Unit,
    showMenu: Boolean = true,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(CardBackground)
            .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (showMenu && onMenuClick != null) {
            IconButton(onClick = onMenuClick, modifier = Modifier.semantics {
                contentDescription = "Open navigation menu"
            }) {
                Icon(Icons.Outlined.Menu, contentDescription = null, tint = TextInk)
            }
        } else {
            Spacer(Modifier.width(8.dp))
        }
        GatcBrandMark(compact = true)
        Spacer(Modifier.weight(1f))
        Box {
            IconButton(onClick = {}) {
                Icon(Icons.Outlined.Notifications, contentDescription = "Notifications", tint = TextInk)
            }
            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = 10.dp, end = 12.dp)
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(PrimaryBlue),
            )
        }
        Box(
            modifier = Modifier
                .padding(end = 8.dp)
                .size(36.dp)
                .clip(CircleShape)
                .background(SoftBlue)
                .clickable(onClick = onProfileClick),
            contentAlignment = Alignment.Center,
        ) {
            Text("RC", color = PrimaryBlue, style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
fun SampleBanner(text: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(SoftBlue)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Outlined.Info, contentDescription = null, tint = PrimaryBlue, modifier = Modifier.size(16.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = PrimaryBlueDark)
    }
}

@Composable
fun GatcCard(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(CardBackground)
            .border(1.dp, Border, RoundedCornerShape(14.dp))
            .padding(14.dp),
        content = content,
    )
}

@Composable
fun VerificationActionCard(
    onNewOv: () -> Unit,
    onNewRv: () -> Unit,
    expanded: Boolean = false,
) {
    val shape = RoundedCornerShape(16.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(
                Brush.linearGradient(
                    listOf(PrimaryBlue, PrimaryBlueDark, Navy),
                ),
            )
            .padding(if (expanded) 20.dp else 16.dp),
    ) {
        Text(
            "GATC VERIFICATION CENTRE",
            style = MaterialTheme.typography.labelSmall,
            color = Color.White.copy(alpha = 0.85f),
        )
        Spacer(Modifier.height(6.dp))
        Text(
            "Start a verification",
            style = MaterialTheme.typography.headlineMedium,
            color = Color.White,
        )
        Text(
            "New instrument or periodic verification.",
            style = MaterialTheme.typography.bodyMedium,
            color = Color.White.copy(alpha = 0.9f),
        )
        Spacer(Modifier.height(14.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Surface(
                onClick = onNewOv,
                shape = RoundedCornerShape(24.dp),
                color = Color.White,
                modifier = Modifier.height(44.dp),
            ) {
                Row(
                    Modifier.padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text("+", color = PrimaryBlue, fontWeight = FontWeight.Bold)
                    Text("New OV", color = PrimaryBlue, fontWeight = FontWeight.SemiBold)
                }
            }
            Surface(
                onClick = onNewRv,
                shape = RoundedCornerShape(24.dp),
                color = Color.Transparent,
                border = androidx.compose.foundation.BorderStroke(1.dp, Color.White.copy(alpha = 0.7f)),
                modifier = Modifier.height(44.dp),
            ) {
                Row(
                    Modifier.padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(Icons.Outlined.Sync, contentDescription = null, tint = Color.White, modifier = Modifier.size(16.dp))
                    Text("New RV", color = Color.White, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

@Composable
fun KpiCard(
    title: String,
    value: String,
    subtitle: String,
    icon: ImageVector,
    iconTint: Color = PrimaryBlue,
    iconBg: Color = SoftBlue,
    modifier: Modifier = Modifier,
) {
    GatcCard(modifier = modifier) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(36.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(iconBg),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = null, tint = iconTint, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.weight(1f))
        }
        Spacer(Modifier.height(10.dp))
        Text(value, style = MaterialTheme.typography.headlineMedium)
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(subtitle, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
fun AttentionList(
    items: List<AttentionItem>,
    openCount: Int,
) {
    GatcCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Needs attention", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            Box(
                Modifier
                    .clip(RoundedCornerShape(20.dp))
                    .background(WarningSoft)
                    .padding(horizontal = 10.dp, vertical = 4.dp),
            ) {
                Text("$openCount Open", color = WarningAmber, style = MaterialTheme.typography.labelMedium)
            }
        }
        Spacer(Modifier.height(10.dp))
        items.forEachIndexed { index, item ->
            if (index > 0) Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                val bg = if (item.kind == AttentionKind.PENDING_SUBMISSIONS) WarningSoft else SoftBlue
                val tint = if (item.kind == AttentionKind.PENDING_SUBMISSIONS) WarningAmber else PrimaryBlue
                val icon = if (item.kind == AttentionKind.PENDING_SUBMISSIONS) {
                    Icons.Outlined.Info
                } else {
                    Icons.Outlined.Description
                }
                Box(
                    Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(bg),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(item.title, style = MaterialTheme.typography.titleMedium)
                    Text(item.subtitle, style = MaterialTheme.typography.bodySmall)
                }
                Text("${item.count}", style = MaterialTheme.typography.headlineMedium)
            }
        }
    }
}

@Composable
fun StatusChip(status: VerificationUiStatus) {
    val (bg, fg) = when (status) {
        VerificationUiStatus.COMPLETED -> SuccessSoft to SuccessGreen
        VerificationUiStatus.AWAITING_PDF -> InfoSoft to PrimaryBlue
        VerificationUiStatus.PENDING, VerificationUiStatus.DRAFT -> WarningSoft to WarningAmber
        VerificationUiStatus.REJECTED -> WarningSoft to WarningAmber
    }
    Box(
        Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(bg)
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text(status.label(), color = fg, style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
fun VerificationRow(
    record: VerificationRecord,
    onClick: () -> Unit,
) {
    GatcCard(modifier = Modifier.clickable(onClick = onClick)) {
        Row(verticalAlignment = Alignment.Top) {
            Box(
                Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(SoftBlue),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (record.status == VerificationUiStatus.COMPLETED) {
                        Icons.Outlined.CheckCircle
                    } else {
                        Icons.Outlined.Description
                    },
                    contentDescription = null,
                    tint = PrimaryBlue,
                )
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        record.customerName,
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.weight(1f),
                    )
                    StatusChip(record.status)
                }
                Text(
                    "${record.reference} · ${record.jobType.name} · ${record.productName} · ${record.capacityLabel}",
                    style = MaterialTheme.typography.bodySmall,
                )
                Text(record.dateLabel, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
fun SegmentedChips(
    options: List<Pair<String, Boolean>>,
    onSelect: (Int) -> Unit,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEachIndexed { index, (label, selected) ->
            Surface(
                onClick = { onSelect(index) },
                shape = RoundedCornerShape(20.dp),
                color = if (selected) SoftBlue else Color.Transparent,
            ) {
                Text(
                    label,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                    color = if (selected) PrimaryBlue else MutedText,
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
    }
}

@Composable
fun EmptyState(title: String, subtitle: String) {
    GatcCard {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(subtitle, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
fun ModuleListHeader(title: String, subtitle: String, actionLabel: String? = null, onAction: (() -> Unit)? = null) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.headlineMedium)
            Text(subtitle, style = MaterialTheme.typography.bodySmall)
        }
        if (actionLabel != null && onAction != null) {
            TextButton(onClick = onAction) {
                Text(actionLabel, color = PrimaryBlue)
            }
        }
    }
}

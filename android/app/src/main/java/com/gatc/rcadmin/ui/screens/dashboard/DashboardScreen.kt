package com.gatc.rcadmin.ui.screens.dashboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.gatc.rcadmin.data.model.ReportingPeriod
import com.gatc.rcadmin.data.sample.SampleData
import com.gatc.rcadmin.ui.components.AttentionList
import com.gatc.rcadmin.ui.components.EmptyState
import com.gatc.rcadmin.ui.components.KpiCard
import com.gatc.rcadmin.ui.components.SampleBanner
import com.gatc.rcadmin.ui.components.SegmentedChips
import com.gatc.rcadmin.ui.components.VerificationActionCard
import com.gatc.rcadmin.ui.components.VerificationRow
import com.gatc.rcadmin.ui.theme.MutedText
import com.gatc.rcadmin.ui.theme.PrimaryBlue
import com.gatc.rcadmin.ui.theme.ScreenBackground
import com.gatc.rcadmin.ui.theme.SoftBlue
import com.gatc.rcadmin.ui.theme.SuccessGreen
import com.gatc.rcadmin.ui.theme.SuccessSoft
import com.gatc.rcadmin.viewmodel.DashboardUiState
import com.gatc.rcadmin.viewmodel.RecentFilter

@Composable
fun DashboardScreen(
    state: DashboardUiState,
    expandedLayout: Boolean,
    onPeriodChange: (ReportingPeriod) -> Unit,
    onRecentFilterChange: (RecentFilter) -> Unit,
    onNewOv: () -> Unit,
    onNewRv: () -> Unit,
    onOpenVerification: (String) -> Unit,
    onViewAll: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            SampleBanner(state.sampleBanner)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("RC ADMIN WORKSPACE", style = MaterialTheme.typography.labelSmall, color = MutedText)
                    Text("Dashboard", style = MaterialTheme.typography.headlineMedium)
                }
                Surface(
                    shape = RoundedCornerShape(20.dp),
                    color = ScreenBackground,
                    border = androidx.compose.foundation.BorderStroke(1.dp, SoftBlue),
                ) {
                    Row(
                        Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Icon(Icons.Outlined.CalendarMonth, contentDescription = null, tint = MutedText, modifier = Modifier.size(18.dp))
                        Text("31 Oct", style = MaterialTheme.typography.labelLarge, color = MutedText)
                    }
                }
            }

            VerificationActionCard(onNewOv = onNewOv, onNewRv = onNewRv, expanded = expandedLayout)

            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (expandedLayout) "Summary" else "Verification summary",
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.weight(1f),
                )
                SegmentedChips(
                    options = listOf(
                        "Today" to (state.period == ReportingPeriod.TODAY),
                        "This month" to (state.period == ReportingPeriod.THIS_MONTH),
                    ),
                    onSelect = {
                        onPeriodChange(
                            if (it == 0) ReportingPeriod.TODAY else ReportingPeriod.THIS_MONTH,
                        )
                    },
                )
            }

            if (expandedLayout) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                    KpiCard("Total", "${state.kpis.total}", "All verification requests", Icons.Outlined.Description, modifier = Modifier.weight(1f))
                    KpiCard("Original (OV)", "${state.kpis.originalOv}", "Initial verifications", Icons.Outlined.Description, modifier = Modifier.weight(1f))
                    KpiCard("Re-verify (RV)", "${state.kpis.reVerifyRv}", "Periodic verifications", Icons.Outlined.Sync, modifier = Modifier.weight(1f))
                    KpiCard(
                        "Completed",
                        "${state.kpis.completed}",
                        "Successfully completed",
                        Icons.Outlined.CheckCircle,
                        iconTint = SuccessGreen,
                        iconBg = SuccessSoft,
                        modifier = Modifier.weight(1f),
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.weight(1.4f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        RecentSection(state, onRecentFilterChange, onOpenVerification, onViewAll)
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        AttentionList(state.attention, state.attention.sumOf { it.count })
                    }
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    KpiCard("Total Verifications", "${state.kpis.total}", "All verification requests", Icons.Outlined.Description, modifier = Modifier.weight(1f))
                    KpiCard(
                        "Completed",
                        "${state.kpis.completed}",
                        "Successfully completed",
                        Icons.Outlined.CheckCircle,
                        iconTint = SuccessGreen,
                        iconBg = SuccessSoft,
                        modifier = Modifier.weight(1f),
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    KpiCard("Original (OV)", "${state.kpis.originalOv}", "Initial verifications", Icons.Outlined.Description, modifier = Modifier.weight(1f))
                    KpiCard("Re-verify (RV)", "${state.kpis.reVerifyRv}", "Periodic verifications", Icons.Outlined.Sync, modifier = Modifier.weight(1f))
                }
                AttentionList(state.attention, state.attention.sumOf { it.count })
                RecentSection(state, onRecentFilterChange, onOpenVerification, onViewAll)
            }

            Text(
                SampleData.SAMPLE_FOOTNOTE,
                style = MaterialTheme.typography.bodySmall,
                color = MutedText,
                modifier = Modifier.padding(bottom = 72.dp),
            )
        }
    }
}

@Composable
private fun RecentSection(
    state: DashboardUiState,
    onRecentFilterChange: (RecentFilter) -> Unit,
    onOpenVerification: (String) -> Unit,
    onViewAll: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Recent verifications", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            TextButton(onClick = onViewAll) {
                Text("View all →", color = PrimaryBlue)
            }
        }
        SegmentedChips(
            options = listOf(
                "All" to (state.recentFilter == RecentFilter.ALL),
                "OV" to (state.recentFilter == RecentFilter.OV),
                "RV" to (state.recentFilter == RecentFilter.RV),
            ),
            onSelect = {
                onRecentFilterChange(
                    when (it) {
                        1 -> RecentFilter.OV
                        2 -> RecentFilter.RV
                        else -> RecentFilter.ALL
                    },
                )
            },
        )
        if (state.recent.isEmpty()) {
            EmptyState("No verifications", "Sample list is empty for this filter.")
        } else {
            state.recent.take(5).forEach { record ->
                VerificationRow(record) { onOpenVerification(record.id) }
            }
        }
        TextButton(onClick = onViewAll, modifier = Modifier.align(Alignment.CenterHorizontally)) {
            Text("View verification history →", color = PrimaryBlue)
        }
    }
}

@Composable
fun NewVerificationFab(onClick: () -> Unit) {
    FloatingActionButton(
        onClick = onClick,
        containerColor = SoftBlue,
        contentColor = PrimaryBlue,
        shape = RoundedCornerShape(16.dp),
    ) {
        Text("+ New verification", modifier = Modifier.padding(horizontal = 12.dp), style = MaterialTheme.typography.labelLarge)
    }
}

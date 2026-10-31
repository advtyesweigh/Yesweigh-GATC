package com.gatc.rcadmin.ui.preview

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.gatc.rcadmin.data.model.JobType
import com.gatc.rcadmin.data.model.ReportingPeriod
import com.gatc.rcadmin.data.sample.SampleData
import com.gatc.rcadmin.ui.components.RcDrawerContent
import com.gatc.rcadmin.ui.navigation.Destinations
import com.gatc.rcadmin.ui.screens.CustomerScreen
import com.gatc.rcadmin.ui.screens.dashboard.DashboardScreen
import com.gatc.rcadmin.ui.screens.verification.NewVerificationFormScreen
import com.gatc.rcadmin.ui.theme.GatcRcAdminTheme
import com.gatc.rcadmin.viewmodel.DashboardUiState
import com.gatc.rcadmin.viewmodel.RecentFilter

@Preview(name = "Drawer", showBackground = true, widthDp = 300, heightDp = 780)
@Composable
fun DrawerPreview() {
    GatcRcAdminTheme {
        RcDrawerContent(selectedRoute = Destinations.Dashboard.route, onNavigate = {})
    }
}

@Preview(name = "Dashboard phone", showBackground = true, widthDp = 390, heightDp = 900)
@Composable
fun DashboardPhonePreview() {
    GatcRcAdminTheme {
        DashboardScreen(
            state = DashboardUiState(
                period = ReportingPeriod.THIS_MONTH,
                recentFilter = RecentFilter.ALL,
                kpis = SampleData.kpis(ReportingPeriod.THIS_MONTH),
                attention = SampleData.attention(ReportingPeriod.THIS_MONTH),
                recent = SampleData.verifications,
            ),
            expandedLayout = false,
            onPeriodChange = {},
            onRecentFilterChange = {},
            onNewOv = {},
            onNewRv = {},
            onOpenVerification = {},
            onViewAll = {},
        )
    }
}

@Preview(name = "New OV form", showBackground = true, widthDp = 390, heightDp = 840)
@Composable
fun NewOvFormPreview() {
    GatcRcAdminTheme {
        NewVerificationFormScreen(
            jobType = JobType.OV,
            defaultSeal = SampleData.laboratory.sealIdentification,
            onSave = {},
            onCancel = {},
        )
    }
}

@Preview(name = "Customers", showBackground = true, widthDp = 390, heightDp = 700)
@Composable
fun CustomersPreview() {
    GatcRcAdminTheme {
        CustomerScreen(SampleData.customers)
    }
}

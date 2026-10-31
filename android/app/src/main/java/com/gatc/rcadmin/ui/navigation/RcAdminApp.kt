package com.gatc.rcadmin.ui.navigation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Scaffold
import androidx.compose.material3.rememberDrawerState
import androidx.compose.material3.windowsizeclass.WindowSizeClass
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.gatc.rcadmin.data.model.JobType
import com.gatc.rcadmin.ui.components.GatcTopBar
import com.gatc.rcadmin.ui.components.RcDrawerContent
import com.gatc.rcadmin.ui.screens.CustomerScreen
import com.gatc.rcadmin.ui.screens.LaboratoryScreen
import com.gatc.rcadmin.ui.screens.ProductScreen
import com.gatc.rcadmin.ui.screens.ProfileScreen
import com.gatc.rcadmin.ui.screens.PurchasesScreen
import com.gatc.rcadmin.ui.screens.VctScreen
import com.gatc.rcadmin.ui.screens.VehicleScreen
import com.gatc.rcadmin.ui.screens.dashboard.DashboardScreen
import com.gatc.rcadmin.ui.screens.dashboard.NewVerificationFab
import com.gatc.rcadmin.ui.screens.verification.NewVerificationFormScreen
import com.gatc.rcadmin.ui.screens.verification.VerificationDetailsScreen
import com.gatc.rcadmin.ui.screens.verification.VerificationListScreen
import com.gatc.rcadmin.ui.theme.CardBackground
import com.gatc.rcadmin.ui.theme.ScreenBackground
import com.gatc.rcadmin.viewmodel.RcAdminViewModel
import kotlinx.coroutines.launch

@Composable
fun RcAdminApp(
    windowSizeClass: WindowSizeClass,
    viewModel: RcAdminViewModel = viewModel(factory = RcAdminViewModel.factory()),
) {
    val expanded = windowSizeClass.widthSizeClass != WindowWidthSizeClass.Compact
    val navController = rememberNavController()
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val backStack by navController.currentBackStackEntryAsState()
    val currentRoute = backStack?.destination?.route ?: Destinations.Dashboard.route
    val dashboardState by viewModel.dashboardState.collectAsStateWithLifecycle()
    val verificationList by viewModel.filteredVerifications.collectAsStateWithLifecycle()
    val verificationQuery by viewModel.verificationQuery.collectAsStateWithLifecycle()
    val verificationTypeFilter by viewModel.verificationTypeFilter.collectAsStateWithLifecycle()

    fun navigate(dest: Destinations) {
        navController.navigate(dest.route) {
            popUpTo(Destinations.Dashboard.route) { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
        scope.launch { drawerState.close() }
    }

    val content: @Composable () -> Unit = {
        Scaffold(
            containerColor = ScreenBackground,
            topBar = {
                GatcTopBar(
                    onMenuClick = if (!expanded) {
                        { scope.launch { drawerState.open() } }
                    } else {
                        null
                    },
                    showMenu = !expanded,
                    onProfileClick = { navigate(Destinations.Profile) },
                )
            },
            floatingActionButton = {
                if (currentRoute == Destinations.Dashboard.route ||
                    currentRoute == Destinations.Verification.route
                ) {
                    NewVerificationFab {
                        navController.navigate(Destinations.NewOv.route)
                    }
                }
            },
        ) { padding ->
            Row(
                Modifier
                    .fillMaxSize()
                    .padding(padding),
            ) {
                if (expanded) {
                    RcDrawerContent(
                        selectedRoute = currentRoute,
                        onNavigate = { navigate(it) },
                    )
                }
                Box(Modifier.weight(1f)) {
                    NavHost(
                        navController = navController,
                        startDestination = Destinations.Dashboard.route,
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        composable(Destinations.Dashboard.route) {
                            DashboardScreen(
                                state = dashboardState,
                                expandedLayout = expanded,
                                onPeriodChange = viewModel::setPeriod,
                                onRecentFilterChange = viewModel::setRecentFilter,
                                onNewOv = { navController.navigate(Destinations.NewOv.route) },
                                onNewRv = { navController.navigate(Destinations.NewRv.route) },
                                onOpenVerification = {
                                    navController.navigate(Destinations.VerificationDetails.create(it))
                                },
                                onViewAll = { navigate(Destinations.Verification) },
                            )
                        }
                        composable(Destinations.Verification.route) {
                            VerificationListScreen(
                                records = verificationList,
                                query = verificationQuery,
                                typeFilter = verificationTypeFilter,
                                onQueryChange = viewModel::setVerificationQuery,
                                onTypeFilterChange = viewModel::setVerificationTypeFilter,
                                onOpen = {
                                    navController.navigate(Destinations.VerificationDetails.create(it))
                                },
                                onNewOv = { navController.navigate(Destinations.NewOv.route) },
                                onNewRv = { navController.navigate(Destinations.NewRv.route) },
                            )
                        }
                        composable(Destinations.Customer.route) {
                            CustomerScreen(viewModel.customers())
                        }
                        composable(Destinations.Product.route) {
                            ProductScreen(viewModel.products())
                        }
                        composable(Destinations.Purchases.route) {
                            PurchasesScreen(viewModel.purchases())
                        }
                        composable(Destinations.Vct.route) {
                            VctScreen(viewModel.vcts())
                        }
                        composable(Destinations.Vehicle.route) {
                            VehicleScreen(viewModel.vehicles())
                        }
                        composable(Destinations.Laboratory.route) {
                            LaboratoryScreen(viewModel.laboratory())
                        }
                        composable(Destinations.Profile.route) {
                            ProfileScreen()
                        }
                        composable(Destinations.NewOv.route) {
                            NewVerificationFormScreen(
                                jobType = JobType.OV,
                                defaultSeal = viewModel.laboratory().sealIdentification,
                                onSave = {
                                    val saved = viewModel.saveDraft(it)
                                    navController.navigate(Destinations.VerificationDetails.create(saved.id)) {
                                        popUpTo(Destinations.Dashboard.route)
                                    }
                                },
                                onCancel = { navController.popBackStack() },
                            )
                        }
                        composable(Destinations.NewRv.route) {
                            NewVerificationFormScreen(
                                jobType = JobType.RV,
                                defaultSeal = viewModel.laboratory().sealIdentification,
                                onSave = {
                                    val saved = viewModel.saveDraft(it)
                                    navController.navigate(Destinations.VerificationDetails.create(saved.id)) {
                                        popUpTo(Destinations.Dashboard.route)
                                    }
                                },
                                onCancel = { navController.popBackStack() },
                            )
                        }
                        composable(
                            route = Destinations.VerificationDetails.route,
                            arguments = listOf(navArgument("id") { type = NavType.StringType }),
                        ) { entry ->
                            val id = entry.arguments?.getString("id")
                            VerificationDetailsScreen(
                                record = id?.let(viewModel::verificationById),
                                onBack = { navController.popBackStack() },
                            )
                        }
                    }
                }
            }
        }
    }

    if (expanded) {
        content()
    } else {
        ModalNavigationDrawer(
            drawerState = drawerState,
            drawerContent = {
                ModalDrawerSheet(drawerContainerColor = CardBackground) {
                    RcDrawerContent(
                        selectedRoute = currentRoute,
                        onNavigate = { navigate(it) },
                    )
                }
            },
        ) {
            content()
        }
    }
}

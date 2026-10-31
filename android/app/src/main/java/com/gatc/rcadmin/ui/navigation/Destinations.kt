package com.gatc.rcadmin.ui.navigation

sealed class Destinations(val route: String, val title: String) {
    data object Dashboard : Destinations("dashboard", "Dashboard")
    data object Verification : Destinations("verification", "Verification")
    data object Customer : Destinations("customer", "Customer")
    data object Product : Destinations("product", "Product")
    data object Purchases : Destinations("purchases", "Purchases")
    data object Vct : Destinations("vct", "VCT")
    data object Vehicle : Destinations("vehicle", "Vehicle")
    data object Laboratory : Destinations("laboratory", "Laboratory")
    data object Profile : Destinations("profile", "Profile")
    data object NewOv : Destinations("verification/new/ov", "New OV")
    data object NewRv : Destinations("verification/new/rv", "New RV")
    data object VerificationDetails : Destinations("verification/details/{id}", "Verification details") {
        fun create(id: String) = "verification/details/$id"
    }

    companion object {
        val workspace = listOf(Dashboard, Verification, Customer, Product, Purchases)
        val management = listOf(Vct, Vehicle, Laboratory)
        val allPrimary = workspace + management + listOf(Profile)
    }
}

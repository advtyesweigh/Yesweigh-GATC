package com.gatc.rcadmin.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.gatc.rcadmin.data.model.Customer
import com.gatc.rcadmin.data.model.LaboratorySettings
import com.gatc.rcadmin.data.model.Product
import com.gatc.rcadmin.data.model.Purchase
import com.gatc.rcadmin.data.model.VctUser
import com.gatc.rcadmin.data.model.Vehicle
import com.gatc.rcadmin.data.sample.SampleData
import com.gatc.rcadmin.ui.components.EmptyState
import com.gatc.rcadmin.ui.components.GatcCard
import com.gatc.rcadmin.ui.components.ModuleListHeader
import com.gatc.rcadmin.ui.components.SampleBanner
import com.gatc.rcadmin.ui.theme.MutedText
import com.gatc.rcadmin.ui.theme.SuccessGreen
import com.gatc.rcadmin.ui.theme.WarningAmber

@Composable
fun CustomerScreen(customers: List<Customer>) {
    var query by rememberSaveable { mutableStateOf("") }
    val filtered = customers.filter {
        query.isBlank() || it.name.contains(query, true) || it.phone.contains(query)
    }
    ModuleScaffold(
        title = "Customer",
        subtitle = "RC-managed customers · fields from yesgatc Customer",
    ) {
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Search name or phone") },
            singleLine = true,
        )
        if (filtered.isEmpty()) {
            EmptyState("No customers", "Sample list has no matches.")
        } else {
            filtered.forEach { c ->
                GatcCard {
                    Text(c.name, style = MaterialTheme.typography.titleMedium)
                    Text("${c.phone} · ${c.district}, ${c.state}", style = MaterialTheme.typography.bodySmall)
                    Text(c.address, style = MaterialTheme.typography.bodySmall, color = MutedText)
                }
            }
        }
    }
}

@Composable
fun ProductScreen(products: List<Product>) {
    ModuleScaffold(
        title = "Product",
        subtitle = "Instrument catalogue · yesgatc Product fields",
    ) {
        products.forEach { p ->
            GatcCard {
                Text(p.name, style = MaterialTheme.typography.titleMedium)
                Text("${p.modelNo} · ${p.typeOfInstrument}", style = MaterialTheme.typography.bodySmall)
                Text(
                    "Max ${p.maximumCapacity} ${p.unitOfMeasurement} · Class ${p.accuracyClass} · ${p.modelApprovalNo}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MutedText,
                )
            }
        }
    }
}

@Composable
fun PurchasesScreen(purchases: List<Purchase>) {
    ModuleScaffold(
        title = "Purchases",
        subtitle = "UI scaffold — no Purchases module in yesgatc (sample only)",
    ) {
        GatcCard {
            Text(
                "yesgatc has Wallet / serial allotment / invoices in RV flow, but no standalone Purchases register. This screen is a Phase-1 placeholder.",
                style = MaterialTheme.typography.bodyMedium,
                color = MutedText,
            )
        }
        purchases.forEach { p ->
            GatcCard {
                Text(p.invoiceNo, style = MaterialTheme.typography.titleMedium)
                Text("${p.supplier} · ${p.relatedProductName}", style = MaterialTheme.typography.bodySmall)
                Text("₹${p.amountInr} · ${p.dateLabel}", style = MaterialTheme.typography.bodySmall, color = MutedText)
            }
        }
    }
}

@Composable
fun VctScreen(vcts: List<VctUser>) {
    ModuleScaffold(
        title = "VCT",
        subtitle = "Verification and Calibration Technicians · yesgatc VCTManagement",
    ) {
        vcts.forEach { v ->
            GatcCard {
                Row(Modifier.fillMaxWidth()) {
                    Column(Modifier.weight(1f)) {
                        Text(v.username, style = MaterialTheme.typography.titleMedium)
                        Text("${v.phone} · workflow ${v.workflowMode}", style = MaterialTheme.typography.bodySmall)
                    }
                    Text(
                        v.approvalStatus,
                        color = if (v.approvalStatus == "approved") SuccessGreen else WarningAmber,
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
            }
        }
    }
}

@Composable
fun VehicleScreen(vehicles: List<Vehicle>) {
    ModuleScaffold(
        title = "Vehicle",
        subtitle = "RC vehicle register · yesgatc Vehicle (UI label was Car)",
    ) {
        vehicles.forEach { v ->
            GatcCard {
                Text("${v.brand} ${v.model} (${v.year})", style = MaterialTheme.typography.titleMedium)
                Text(v.regNumber, style = MaterialTheme.typography.bodyLarge)
                Text(
                    "RC ${v.rcValidity} · Insurance ${v.insuranceValidity}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MutedText,
                )
            }
        }
    }
}

@Composable
fun LaboratoryScreen(settings: LaboratorySettings) {
    ModuleScaffold(
        title = "Laboratory",
        subtitle = "Seal ID and lab settings · yesgatc LaboratorySettings",
    ) {
        GatcCard {
            Text("Seal identification", style = MaterialTheme.typography.labelSmall, color = MutedText)
            Text(settings.sealIdentification, style = MaterialTheme.typography.titleLarge)
            Text(settings.notes, style = MaterialTheme.typography.bodySmall, color = MutedText)
        }
    }
}

@Composable
fun ProfileScreen() {
    ModuleScaffold(
        title = "Profile",
        subtitle = "RC Admin identity · sample",
    ) {
        GatcCard {
            Text("RC Administrator", style = MaterialTheme.typography.titleLarge)
            Text("Role: RC Admin", style = MaterialTheme.typography.bodyMedium)
            Text("Regional Centre: Sample RC (demo)", style = MaterialTheme.typography.bodyMedium)
            Text("Logout and security controls arrive with VPS auth.", style = MaterialTheme.typography.bodySmall, color = MutedText)
        }
    }
}

@Composable
private fun ModuleScaffold(
    title: String,
    subtitle: String,
    content: @Composable () -> Unit,
) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        SampleBanner(SampleData.SAMPLE_BANNER)
        ModuleListHeader(title = title, subtitle = subtitle)
        content()
    }
}

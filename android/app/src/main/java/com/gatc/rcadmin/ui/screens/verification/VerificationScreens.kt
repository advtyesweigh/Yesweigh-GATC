package com.gatc.rcadmin.ui.screens.verification

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.gatc.rcadmin.data.model.JobType
import com.gatc.rcadmin.data.model.VerificationDraft
import com.gatc.rcadmin.data.model.VerificationRecord
import com.gatc.rcadmin.data.model.label
import com.gatc.rcadmin.data.sample.SampleData
import com.gatc.rcadmin.ui.components.EmptyState
import com.gatc.rcadmin.ui.components.GatcCard
import com.gatc.rcadmin.ui.components.ModuleListHeader
import com.gatc.rcadmin.ui.components.SampleBanner
import com.gatc.rcadmin.ui.components.SegmentedChips
import com.gatc.rcadmin.ui.components.StatusChip
import com.gatc.rcadmin.ui.components.VerificationRow
import com.gatc.rcadmin.ui.theme.MutedText
import com.gatc.rcadmin.viewmodel.RecentFilter

@Composable
fun VerificationListScreen(
    records: List<VerificationRecord>,
    query: String,
    typeFilter: RecentFilter,
    onQueryChange: (String) -> Unit,
    onTypeFilterChange: (RecentFilter) -> Unit,
    onOpen: (String) -> Unit,
    onNewOv: () -> Unit,
    onNewRv: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        SampleBanner(SampleData.SAMPLE_BANNER)
        ModuleListHeader(
            title = "Verification",
            subtitle = "OV / RV requests · sample data",
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onNewOv, modifier = Modifier.weight(1f)) { Text("New OV") }
            OutlinedButton(onClick = onNewRv, modifier = Modifier.weight(1f)) { Text("New RV") }
        }
        OutlinedTextField(
            value = query,
            onValueChange = onQueryChange,
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Search customer, reference, serial") },
            singleLine = true,
        )
        SegmentedChips(
            options = listOf(
                "All" to (typeFilter == RecentFilter.ALL),
                "OV" to (typeFilter == RecentFilter.OV),
                "RV" to (typeFilter == RecentFilter.RV),
            ),
            onSelect = {
                onTypeFilterChange(
                    when (it) {
                        1 -> RecentFilter.OV
                        2 -> RecentFilter.RV
                        else -> RecentFilter.ALL
                    },
                )
            },
        )
        if (records.isEmpty()) {
            EmptyState("No matching verifications", "Try another filter or create a sample draft.")
        } else {
            records.forEach { VerificationRow(it) { onOpen(it.id) } }
        }
    }
}

@Composable
fun VerificationDetailsScreen(record: VerificationRecord?, onBack: () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        SampleBanner(SampleData.SAMPLE_BANNER)
        Text("Verification details", style = MaterialTheme.typography.headlineMedium)
        if (record == null) {
            EmptyState("Not found", "This sample record is unavailable.")
        } else {
            GatcCard {
                Row {
                    Text(record.customerName, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                    StatusChip(record.status)
                }
                Spacer(Modifier.height(8.dp))
                DetailLine("Reference", record.reference)
                DetailLine("Type", record.jobType.name)
                DetailLine("Product", record.productName)
                DetailLine("Capacity", record.capacityLabel)
                DetailLine("Serial", record.serialNumber)
                DetailLine("Status", record.status.label())
                DetailLine("Date", record.dateLabel)
                if (record.sealIdentificationNumber.isNotBlank()) {
                    DetailLine("Seal ID", record.sealIdentificationNumber)
                }
                if (record.manufacturingYear.isNotBlank()) {
                    DetailLine("Manufacturing year", record.manufacturingYear)
                }
            }
        }
        OutlinedButton(onClick = onBack) { Text("Back") }
    }
}

@Composable
private fun DetailLine(label: String, value: String) {
    Column(Modifier.padding(vertical = 4.dp)) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MutedText)
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
fun NewVerificationFormScreen(
    jobType: JobType,
    defaultSeal: String,
    onSave: (VerificationDraft) -> Unit,
    onCancel: () -> Unit,
) {
    var customerName by rememberSaveable { mutableStateOf("") }
    var customerPhone by rememberSaveable { mutableStateOf("") }
    var productName by rememberSaveable { mutableStateOf("") }
    var serialNumber by rememberSaveable { mutableStateOf("") }
    var maximumCapacity by rememberSaveable { mutableStateOf("") }
    var ambientTemperature by rememberSaveable { mutableStateOf("") }
    var relativeHumidity by rememberSaveable { mutableStateOf("") }
    var sealId by rememberSaveable { mutableStateOf(defaultSeal) }
    var manufacturingYear by rememberSaveable { mutableStateOf("") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SampleBanner("Sample ${jobType.name} draft · local only · not submitted to VPS/eMaap")
        Text(
            if (jobType == JobType.OV) "New Original Verification (OV)" else "New Re-verification (RV)",
            style = MaterialTheme.typography.headlineMedium,
        )
        Text(
            "Fields aligned with yesgatc SiteCalibration / Customer where verified.",
            style = MaterialTheme.typography.bodySmall,
            color = MutedText,
        )
        OutlinedTextField(customerName, { customerName = it; error = null }, label = { Text("Customer name *") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(customerPhone, { customerPhone = it }, label = { Text("Customer phone") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(productName, { productName = it; error = null }, label = { Text("Product / instrument *") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(serialNumber, { serialNumber = it; error = null }, label = { Text("Serial number *") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(maximumCapacity, { maximumCapacity = it }, label = { Text("Maximum capacity (kg)") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(ambientTemperature, { ambientTemperature = it }, label = { Text("Ambient temperature") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(relativeHumidity, { relativeHumidity = it }, label = { Text("Relative humidity") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(sealId, { sealId = it }, label = { Text("Seal identification number") }, modifier = Modifier.fillMaxWidth())
        if (jobType == JobType.RV) {
            OutlinedTextField(
                manufacturingYear,
                { manufacturingYear = it },
                label = { Text("Manufacturing year (RV)") },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    if (customerName.isBlank() || productName.isBlank() || serialNumber.isBlank()) {
                        error = "Customer, product and serial are required for a sample draft."
                        return@Button
                    }
                    onSave(
                        VerificationDraft(
                            jobType = jobType,
                            customerName = customerName.trim(),
                            customerPhone = customerPhone.trim(),
                            productName = productName.trim(),
                            serialNumber = serialNumber.trim(),
                            maximumCapacity = maximumCapacity.trim(),
                            ambientTemperature = ambientTemperature.trim(),
                            relativeHumidity = relativeHumidity.trim(),
                            sealIdentificationNumber = sealId.trim(),
                            manufacturingYear = manufacturingYear.trim(),
                        ),
                    )
                },
                modifier = Modifier.weight(1f),
            ) { Text("Save sample draft") }
            OutlinedButton(onClick = onCancel, modifier = Modifier.weight(1f)) { Text("Cancel") }
        }
    }
}

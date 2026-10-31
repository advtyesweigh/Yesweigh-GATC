package com.gatc.rcadmin.data.model

/**
 * Domain models aligned with yesgatc where verified.
 * Sample/local-only for Phase 1 — not connected to VPS.
 */
enum class JobType { OV, RV }

enum class VerificationUiStatus {
    DRAFT,
    PENDING,
    AWAITING_PDF,
    COMPLETED,
    REJECTED,
}

enum class ReportingPeriod { TODAY, THIS_MONTH }

data class VerificationRecord(
    val id: String,
    val reference: String,
    val jobType: JobType,
    val customerName: String,
    val productName: String,
    val capacityLabel: String,
    val serialNumber: String,
    val status: VerificationUiStatus,
    val dateLabel: String,
    val ambientTemperature: String = "",
    val relativeHumidity: String = "",
    val sealIdentificationNumber: String = "",
    val manufacturingYear: String = "",
)

data class Customer(
    val id: String,
    val name: String,
    val phone: String,
    val email: String = "",
    val address: String,
    val pincode: String = "",
    val state: String = "",
    val district: String = "",
)

data class Product(
    val id: String,
    val modelNo: String,
    val name: String,
    val typeOfInstrument: String,
    val manufacturerBrandSeries: String,
    val accuracyClass: String,
    val maximumCapacity: Double,
    val minimumCapacity: Double,
    val verificationScaleInterval: Double,
    val unitOfMeasurement: String,
    val modelApprovalNo: String,
)

/** UI label "Purchases" — no matching module in yesgatc; scaffold only. */
data class Purchase(
    val id: String,
    val invoiceNo: String,
    val supplier: String,
    val relatedProductName: String,
    val amountInr: String,
    val dateLabel: String,
)

data class VctUser(
    val id: String,
    val username: String,
    val phone: String,
    val workflowMode: String,
    val approvalStatus: String,
    val active: Boolean,
)

data class Vehicle(
    val id: String,
    val brand: String,
    val model: String,
    val year: String,
    val regNumber: String,
    val rcValidity: String,
    val insuranceValidity: String,
    val active: Boolean,
)

data class LaboratorySettings(
    val sealIdentification: String,
    val notes: String = "",
)

data class AttentionItem(
    val id: String,
    val title: String,
    val subtitle: String,
    val count: Int,
    val kind: AttentionKind,
)

enum class AttentionKind { PENDING_SUBMISSIONS, SIGNED_PDFS }

data class DashboardKpis(
    val total: Int,
    val completed: Int,
    val originalOv: Int,
    val reVerifyRv: Int,
)

data class VerificationDraft(
    val jobType: JobType,
    val customerName: String = "",
    val customerPhone: String = "",
    val productName: String = "",
    val serialNumber: String = "",
    val maximumCapacity: String = "",
    val ambientTemperature: String = "",
    val relativeHumidity: String = "",
    val sealIdentificationNumber: String = "",
    val manufacturingYear: String = "",
    val verificationLocation: String = "in_premises",
)

fun VerificationUiStatus.label(): String = when (this) {
    VerificationUiStatus.DRAFT -> "Draft"
    VerificationUiStatus.PENDING -> "Pending"
    VerificationUiStatus.AWAITING_PDF -> "Awaiting PDF"
    VerificationUiStatus.COMPLETED -> "Completed"
    VerificationUiStatus.REJECTED -> "Rejected"
}

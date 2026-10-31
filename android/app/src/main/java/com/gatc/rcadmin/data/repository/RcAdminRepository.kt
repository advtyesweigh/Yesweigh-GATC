package com.gatc.rcadmin.data.repository

import com.gatc.rcadmin.data.model.AttentionItem
import com.gatc.rcadmin.data.model.Customer
import com.gatc.rcadmin.data.model.DashboardKpis
import com.gatc.rcadmin.data.model.JobType
import com.gatc.rcadmin.data.model.LaboratorySettings
import com.gatc.rcadmin.data.model.Product
import com.gatc.rcadmin.data.model.Purchase
import com.gatc.rcadmin.data.model.ReportingPeriod
import com.gatc.rcadmin.data.model.VctUser
import com.gatc.rcadmin.data.model.Vehicle
import com.gatc.rcadmin.data.model.VerificationDraft
import com.gatc.rcadmin.data.model.VerificationRecord
import com.gatc.rcadmin.data.model.VerificationUiStatus
import com.gatc.rcadmin.data.sample.SampleData
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.util.UUID

interface RcAdminRepository {
    val verifications: StateFlow<List<VerificationRecord>>
    val drafts: StateFlow<List<VerificationDraft>>
    fun kpis(period: ReportingPeriod): DashboardKpis
    fun attention(period: ReportingPeriod): List<AttentionItem>
    fun customers(): List<Customer>
    fun products(): List<Product>
    fun purchases(): List<Purchase>
    fun vcts(): List<VctUser>
    fun vehicles(): List<Vehicle>
    fun laboratory(): LaboratorySettings
    fun verificationById(id: String): VerificationRecord?
    fun saveDraft(draft: VerificationDraft): VerificationRecord
}

class SampleRcAdminRepository : RcAdminRepository {
    private val _verifications = MutableStateFlow(SampleData.verifications)
    private val _drafts = MutableStateFlow<List<VerificationDraft>>(emptyList())

    override val verifications: StateFlow<List<VerificationRecord>> = _verifications.asStateFlow()
    override val drafts: StateFlow<List<VerificationDraft>> = _drafts.asStateFlow()

    override fun kpis(period: ReportingPeriod): DashboardKpis = SampleData.kpis(period)

    override fun attention(period: ReportingPeriod): List<AttentionItem> =
        SampleData.attention(period)

    override fun customers(): List<Customer> = SampleData.customers

    override fun products(): List<Product> = SampleData.products

    override fun purchases(): List<Purchase> = SampleData.purchases

    override fun vcts(): List<VctUser> = SampleData.vcts

    override fun vehicles(): List<Vehicle> = SampleData.vehicles

    override fun laboratory(): LaboratorySettings = SampleData.laboratory

    override fun verificationById(id: String): VerificationRecord? =
        _verifications.value.find { it.id == id }

    override fun saveDraft(draft: VerificationDraft): VerificationRecord {
        _drafts.update { it + draft }
        val nextRef = "GATC-S${1000 + _verifications.value.size}"
        val record = VerificationRecord(
            id = UUID.randomUUID().toString(),
            reference = nextRef,
            jobType = draft.jobType,
            customerName = draft.customerName.ifBlank { "Sample customer" },
            productName = draft.productName.ifBlank { "Sample product" },
            capacityLabel = draft.maximumCapacity.ifBlank { "—" }.let {
                if (it == "—") it else "$it kg"
            },
            serialNumber = draft.serialNumber.ifBlank { "SAMPLE-SN" },
            status = VerificationUiStatus.DRAFT,
            dateLabel = "31 Oct 2026",
            ambientTemperature = draft.ambientTemperature,
            relativeHumidity = draft.relativeHumidity,
            sealIdentificationNumber = draft.sealIdentificationNumber,
            manufacturingYear = draft.manufacturingYear,
        )
        _verifications.update { listOf(record) + it }
        return record
    }
}

object RepositoryProvider {
    val repository: RcAdminRepository by lazy { SampleRcAdminRepository() }
}

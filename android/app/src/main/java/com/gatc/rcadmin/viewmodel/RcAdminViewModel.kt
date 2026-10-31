package com.gatc.rcadmin.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
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
import com.gatc.rcadmin.data.repository.RcAdminRepository
import com.gatc.rcadmin.data.repository.RepositoryProvider
import com.gatc.rcadmin.data.sample.SampleData
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn

enum class RecentFilter { ALL, OV, RV }

data class DashboardUiState(
    val period: ReportingPeriod = ReportingPeriod.THIS_MONTH,
    val recentFilter: RecentFilter = RecentFilter.ALL,
    val kpis: DashboardKpis = SampleData.kpis(ReportingPeriod.THIS_MONTH),
    val attention: List<AttentionItem> = SampleData.attention(ReportingPeriod.THIS_MONTH),
    val recent: List<VerificationRecord> = emptyList(),
    val sampleBanner: String = SampleData.SAMPLE_BANNER,
)

class RcAdminViewModel(
    private val repository: RcAdminRepository = RepositoryProvider.repository,
) : ViewModel() {

    private val period = MutableStateFlow(ReportingPeriod.THIS_MONTH)
    private val recentFilter = MutableStateFlow(RecentFilter.ALL)

    val dashboardState: StateFlow<DashboardUiState> = combine(
        period,
        recentFilter,
        repository.verifications,
    ) { p, filter, records ->
        val filtered = when (filter) {
            RecentFilter.ALL -> records
            RecentFilter.OV -> records.filter { it.jobType == JobType.OV }
            RecentFilter.RV -> records.filter { it.jobType == JobType.RV }
        }
        DashboardUiState(
            period = p,
            recentFilter = filter,
            kpis = repository.kpis(p),
            attention = repository.attention(p),
            recent = filtered,
            sampleBanner = SampleData.SAMPLE_BANNER,
        )
    }.stateIn(
        viewModelScope,
        SharingStarted.WhileSubscribed(5_000),
        DashboardUiState(recent = repository.verifications.value),
    )

    val verifications: StateFlow<List<VerificationRecord>> = repository.verifications

    private val _verificationQuery = MutableStateFlow("")
    val verificationQuery = _verificationQuery.asStateFlow()

    private val _verificationTypeFilter = MutableStateFlow(RecentFilter.ALL)
    val verificationTypeFilter = _verificationTypeFilter.asStateFlow()

    val filteredVerifications: StateFlow<List<VerificationRecord>> = combine(
        repository.verifications,
        _verificationQuery,
        _verificationTypeFilter,
    ) { records, query, typeFilter ->
        records
            .filter {
                when (typeFilter) {
                    RecentFilter.ALL -> true
                    RecentFilter.OV -> it.jobType == JobType.OV
                    RecentFilter.RV -> it.jobType == JobType.RV
                }
            }
            .filter {
                query.isBlank() ||
                    it.customerName.contains(query, ignoreCase = true) ||
                    it.reference.contains(query, ignoreCase = true) ||
                    it.serialNumber.contains(query, ignoreCase = true)
            }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    fun setPeriod(period: ReportingPeriod) {
        this.period.value = period
    }

    fun setRecentFilter(filter: RecentFilter) {
        recentFilter.value = filter
    }

    fun setVerificationQuery(query: String) {
        _verificationQuery.value = query
    }

    fun setVerificationTypeFilter(filter: RecentFilter) {
        _verificationTypeFilter.value = filter
    }

    fun customers(): List<Customer> = repository.customers()
    fun products(): List<Product> = repository.products()
    fun purchases(): List<Purchase> = repository.purchases()
    fun vcts(): List<VctUser> = repository.vcts()
    fun vehicles(): List<Vehicle> = repository.vehicles()
    fun laboratory(): LaboratorySettings = repository.laboratory()
    fun verificationById(id: String): VerificationRecord? = repository.verificationById(id)

    fun saveDraft(draft: VerificationDraft): VerificationRecord = repository.saveDraft(draft)

    companion object {
        fun factory(): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                return RcAdminViewModel() as T
            }
        }
    }
}

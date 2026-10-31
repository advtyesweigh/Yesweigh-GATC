package com.gatc.rcadmin.data.sample

import com.gatc.rcadmin.data.model.AttentionItem
import com.gatc.rcadmin.data.model.AttentionKind
import com.gatc.rcadmin.data.model.Customer
import com.gatc.rcadmin.data.model.DashboardKpis
import com.gatc.rcadmin.data.model.JobType
import com.gatc.rcadmin.data.model.LaboratorySettings
import com.gatc.rcadmin.data.model.Product
import com.gatc.rcadmin.data.model.Purchase
import com.gatc.rcadmin.data.model.ReportingPeriod
import com.gatc.rcadmin.data.model.VctUser
import com.gatc.rcadmin.data.model.Vehicle
import com.gatc.rcadmin.data.model.VerificationRecord
import com.gatc.rcadmin.data.model.VerificationUiStatus

/** Explicitly labeled sample fixtures — not VPS or government data. */
object SampleData {
    const val SAMPLE_BANNER = "Sample UI only · Not connected to VPS"
    const val SAMPLE_FOOTNOTE =
        "Interactive reference only · Sample data · No connection to VPS or government portal"

    val customers = listOf(
        Customer(
            id = "c1",
            name = "Metro Weighing Solutions",
            phone = "9876543210",
            email = "ops@metroweigh.example",
            address = "12 Industrial Estate, Kochi",
            pincode = "682001",
            state = "Kerala",
            district = "Ernakulam",
        ),
        Customer(
            id = "c2",
            name = "Coastal Traders",
            phone = "9898989898",
            address = "NH Bypass, Thrissur",
            pincode = "680001",
            state = "Kerala",
            district = "Thrissur",
        ),
        Customer(
            id = "c3",
            name = "Highland Agro Mart",
            phone = "9765432109",
            address = "Market Road, Idukki",
            pincode = "685501",
            state = "Kerala",
            district = "Idukki",
        ),
    )

    val products = listOf(
        Product(
            id = "p1",
            modelNo = "EWS-30",
            name = "Electronic Scale",
            typeOfInstrument = "Electronic Weighing Instrument",
            manufacturerBrandSeries = "GATC Series A",
            accuracyClass = "III",
            maximumCapacity = 30.0,
            minimumCapacity = 0.1,
            verificationScaleInterval = 0.01,
            unitOfMeasurement = "kg",
            modelApprovalNo = "IND/09/XX/001",
        ),
        Product(
            id = "p2",
            modelNo = "EWS-150",
            name = "Platform Scale",
            typeOfInstrument = "Electronic Weighing Instrument",
            manufacturerBrandSeries = "GATC Series B",
            accuracyClass = "III",
            maximumCapacity = 150.0,
            minimumCapacity = 0.5,
            verificationScaleInterval = 0.05,
            unitOfMeasurement = "kg",
            modelApprovalNo = "IND/09/XX/002",
        ),
    )

    val purchases = listOf(
        Purchase(
            id = "pur1",
            invoiceNo = "INV-SAMPLE-101",
            supplier = "Sample Supplier (demo)",
            relatedProductName = "Electronic Scale",
            amountInr = "12,500",
            dateLabel = "28 Oct 2026",
        ),
        Purchase(
            id = "pur2",
            invoiceNo = "INV-SAMPLE-102",
            supplier = "Demo Parts Co.",
            relatedProductName = "Platform Scale",
            amountInr = "28,000",
            dateLabel = "15 Oct 2026",
        ),
    )

    val vcts = listOf(
        VctUser(
            id = "v1",
            username = "Anil Kumar",
            phone = "9000000001",
            workflowMode = "manual",
            approvalStatus = "approved",
            active = true,
        ),
        VctUser(
            id = "v2",
            username = "Sneha R",
            phone = "9000000002",
            workflowMode = "auto",
            approvalStatus = "pending",
            active = true,
        ),
    )

    val vehicles = listOf(
        Vehicle(
            id = "veh1",
            brand = "Tata",
            model = "Ace",
            year = "2022",
            regNumber = "KL-07-AB-1234",
            rcValidity = "2030-01-15",
            insuranceValidity = "2027-03-01",
            active = true,
        ),
    )

    val laboratory = LaboratorySettings(
        sealIdentification = "IND/GATC/KL/26/04/C26",
        notes = "Sample laboratory seal — from yesgatc laboratorySealIdentification pattern.",
    )

    val verifications = listOf(
        VerificationRecord(
            id = "vr1",
            reference = "GATC-1042",
            jobType = JobType.RV,
            customerName = "Metro Weighing Solutions",
            productName = "Electronic Scale",
            capacityLabel = "30 kg",
            serialNumber = "SN-1042",
            status = VerificationUiStatus.AWAITING_PDF,
            dateLabel = "31 Oct 2026",
            sealIdentificationNumber = "IND/GATC/KL/26/04/C26",
        ),
        VerificationRecord(
            id = "vr2",
            reference = "GATC-1038",
            jobType = JobType.OV,
            customerName = "Coastal Traders",
            productName = "Platform Scale",
            capacityLabel = "150 kg",
            serialNumber = "SN-1038",
            status = VerificationUiStatus.COMPLETED,
            dateLabel = "30 Oct 2026",
        ),
        VerificationRecord(
            id = "vr3",
            reference = "GATC-1031",
            jobType = JobType.RV,
            customerName = "Highland Agro Mart",
            productName = "Electronic Scale",
            capacityLabel = "30 kg",
            serialNumber = "SN-1031",
            status = VerificationUiStatus.PENDING,
            dateLabel = "29 Oct 2026",
            manufacturingYear = "2021",
        ),
    )

    fun kpis(period: ReportingPeriod): DashboardKpis = when (period) {
        ReportingPeriod.TODAY -> DashboardKpis(
            total = 6,
            completed = 4,
            originalOv = 2,
            reVerifyRv = 4,
        )
        ReportingPeriod.THIS_MONTH -> DashboardKpis(
            total = 100,
            completed = 88,
            originalOv = 28,
            reVerifyRv = 72,
        )
    }

    fun attention(period: ReportingPeriod): List<AttentionItem> {
        val pending = if (period == ReportingPeriod.TODAY) 2 else 7
        val pdfs = if (period == ReportingPeriod.TODAY) 1 else 5
        return listOf(
            AttentionItem(
                id = "a1",
                title = "Pending submissions",
                subtitle = "Awaiting government processing",
                count = pending,
                kind = AttentionKind.PENDING_SUBMISSIONS,
            ),
            AttentionItem(
                id = "a2",
                title = "Signed PDFs pending",
                subtitle = "Certificates to upload",
                count = pdfs,
                kind = AttentionKind.SIGNED_PDFS,
            ),
        )
    }
}

-- Strategy approval workflow and stored audience context.
ALTER TABLE `ai_strategies`
    ADD COLUMN `status` VARCHAR(30) NOT NULL DEFAULT 'draft',
    ADD COLUMN `sourceContext` JSON NULL,
    ADD COLUMN `approvedAt` DATETIME(3) NULL,
    ADD COLUMN `approvedByUserId` INTEGER NULL;

CREATE INDEX `ai_strategies_status_idx` ON `ai_strategies`(`status`);
CREATE INDEX `ai_strategies_approvedByUserId_idx` ON `ai_strategies`(`approvedByUserId`);

ALTER TABLE `ai_strategies`
    ADD CONSTRAINT `ai_strategies_approvedByUserId_fkey`
    FOREIGN KEY (`approvedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Outreach campaigns, recipients, and opt-out suppression list.
CREATE TABLE `outreach_campaigns` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(160) NOT NULL,
    `promoCodePrefix` VARCHAR(40) NOT NULL,
    `campaignDate` DATETIME(3) NOT NULL,
    `campaignDay` VARCHAR(20) NOT NULL,
    `sessionName` VARCHAR(30) NOT NULL,
    `courtType` VARCHAR(30) NOT NULL,
    `segmentName` VARCHAR(100) NULL,
    `customerType` VARCHAR(30) NOT NULL DEFAULT 'all',
    `status` VARCHAR(30) NOT NULL DEFAULT 'draft',
    `costBudget` DECIMAL(14, 2) NULL,
    `controlPercent` INTEGER NOT NULL DEFAULT 10,
    `consentConfirmed` BOOLEAN NOT NULL DEFAULT false,
    `consentConfirmedAt` DATETIME(3) NULL,
    `audienceFilters` JSON NULL,
    `createdByUserId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `outreach_campaigns_campaignDate_idx`(`campaignDate`),
    INDEX `outreach_campaigns_status_idx`(`status`),
    INDEX `outreach_campaigns_createdByUserId_idx`(`createdByUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `outreach_recipients` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `campaignId` INTEGER NOT NULL,
    `customerKey` VARCHAR(50) NOT NULL,
    `customerName` VARCHAR(191) NULL,
    `phone` VARCHAR(50) NULL,
    `rfmSegmentName` VARCHAR(100) NULL,
    `preferredSession` VARCHAR(30) NULL,
    `customerTypeLabel` VARCHAR(50) NULL,
    `totalBookingCount` INTEGER NOT NULL DEFAULT 0,
    `recencyDays` INTEGER NOT NULL DEFAULT 999,
    `suggestedAction` VARCHAR(200) NULL,
    `promoCode` VARCHAR(60) NOT NULL,
    `isControl` BOOLEAN NOT NULL DEFAULT false,
    `status` VARCHAR(30) NOT NULL DEFAULT 'pending',
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `outreach_recipients_promoCode_key`(`promoCode`),
    INDEX `outreach_recipients_campaignId_idx`(`campaignId`),
    INDEX `outreach_recipients_customerKey_idx`(`customerKey`),
    INDEX `outreach_recipients_promoCode_idx`(`promoCode`),
    INDEX `outreach_recipients_status_idx`(`status`),
    UNIQUE INDEX `outreach_recipients_campaignId_customerKey_key`(`campaignId`, `customerKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `outreach_suppressions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `customerKey` VARCHAR(50) NOT NULL,
    `reason` VARCHAR(255) NULL,
    `createdByUserId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `outreach_suppressions_customerKey_key`(`customerKey`),
    INDEX `outreach_suppressions_createdByUserId_idx`(`createdByUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `outreach_campaigns`
    ADD CONSTRAINT `outreach_campaigns_createdByUserId_fkey`
    FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `outreach_recipients`
    ADD CONSTRAINT `outreach_recipients_campaignId_fkey`
    FOREIGN KEY (`campaignId`) REFERENCES `outreach_campaigns`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `outreach_suppressions`
    ADD CONSTRAINT `outreach_suppressions_createdByUserId_fkey`
    FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Query indexes for campaign audience and slot availability reads.
CREATE INDEX `facility_transactions_playDate_validBooking_idx` ON `facility_transactions`(`playDate`, `validBooking`);
CREATE INDEX `facility_transactions_customerKey_playDate_idx` ON `facility_transactions`(`customerKey`, `playDate`);
CREATE INDEX `court_hour_usages_playDate_hourStart_idx` ON `court_hour_usages`(`playDate`, `hourStart`);

-- Churn / reactivation-risk prediction model runs and per-customer scores.
CREATE TABLE `churn_model_runs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `trainedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'running',
    `errorMessage` TEXT NULL,
    `featureNames` JSON NULL,
    `coefficients` JSON NULL,
    `intercept` DOUBLE NULL,
    `featureMeans` JSON NULL,
    `featureStds` JSON NULL,
    `threshold` DOUBLE NOT NULL DEFAULT 0.5,
    `trainSize` INTEGER NOT NULL DEFAULT 0,
    `testSize` INTEGER NOT NULL DEFAULT 0,
    `trainPositiveRate` DOUBLE NULL,
    `testPositiveRate` DOUBLE NULL,
    `aucTest` DOUBLE NULL,
    `precisionTest` DOUBLE NULL,
    `recallTest` DOUBLE NULL,
    `f1Test` DOUBLE NULL,
    `performedByUserId` INTEGER NULL,
    INDEX `churn_model_runs_trainedAt_idx`(`trainedAt`),
    INDEX `churn_model_runs_status_idx`(`status`),
    INDEX `churn_model_runs_performedByUserId_idx`(`performedByUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `customer_churn_scores` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `runId` INTEGER NOT NULL,
    `customerKey` VARCHAR(50) NOT NULL,
    `customerName` VARCHAR(191) NULL,
    `churnProbability` DOUBLE NOT NULL,
    `riskLabel` VARCHAR(20) NOT NULL,
    `featuresSnapshot` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `customer_churn_scores_runId_idx`(`runId`),
    INDEX `customer_churn_scores_customerKey_idx`(`customerKey`),
    INDEX `customer_churn_scores_riskLabel_idx`(`riskLabel`),
    INDEX `customer_churn_scores_churnProbability_idx`(`churnProbability`),
    UNIQUE INDEX `customer_churn_scores_runId_customerKey_key`(`runId`, `customerKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `churn_model_runs`
    ADD CONSTRAINT `churn_model_runs_performedByUserId_fkey`
    FOREIGN KEY (`performedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `customer_churn_scores`
    ADD CONSTRAINT `customer_churn_scores_runId_fkey`
    FOREIGN KEY (`runId`) REFERENCES `churn_model_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

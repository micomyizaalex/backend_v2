-- ============================================================
-- Company Verification Flow Migration
-- Date: 2026-03-07
-- ============================================================

-- Step 1: Add company verification columns to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS company_verified BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS account_status   VARCHAR(50) DEFAULT 'approved';

-- Existing approved company_admin users keep 'approved' status.
-- New company_admin registrations will be set to 'pending' via the API.
-- Non-company users default to 'approved' (no restriction applies to them).

-- Step 2: Add country and rejection_reason to companies table
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS country           VARCHAR(100),
  ADD COLUMN IF NOT EXISTS rejection_reason  TEXT;

-- Update already-approved company owners to have approved status
UPDATE users
SET
  company_verified = true,
  account_status   = 'approved'
WHERE role = 'company_admin'
  AND id IN (
    SELECT owner_id FROM companies WHERE status = 'approved'
  );

-- Step 3: Create company_documents table
CREATE TABLE IF NOT EXISTS company_documents (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_type       VARCHAR(100) NOT NULL,
  file_url            TEXT        NOT NULL,
  verification_status VARCHAR(50) NOT NULL DEFAULT 'pending',
  notes               TEXT,
  created_at          TIMESTAMP   NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, document_type)
);

CREATE INDEX IF NOT EXISTS idx_company_documents_company_id ON company_documents(company_id);
CREATE INDEX IF NOT EXISTS idx_company_documents_status     ON company_documents(verification_status);

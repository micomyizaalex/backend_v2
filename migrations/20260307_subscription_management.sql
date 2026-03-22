ALTER TABLE companies
ADD COLUMN IF NOT EXISTS plan VARCHAR(50) DEFAULT 'Starter',
ADD COLUMN IF NOT EXISTS next_payment DATE;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}'::jsonb;

UPDATE companies
SET plan = COALESCE(plan, 'Starter')
WHERE plan IS NULL;

DO $migration$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_name = 'companies' AND column_name = 'subscription_plan'
	) THEN
		EXECUTE 'UPDATE companies SET plan = COALESCE(plan, subscription_plan, ''Starter'') WHERE plan IS NULL;';
	END IF;
END
$migration$;

DO $migration$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_name = 'companies' AND column_name = 'subscription_expires_at'
	) THEN
		EXECUTE 'UPDATE companies SET next_payment = COALESCE(next_payment, subscription_expires_at::date) WHERE next_payment IS NULL AND subscription_expires_at IS NOT NULL;';
	END IF;
END
$migration$;
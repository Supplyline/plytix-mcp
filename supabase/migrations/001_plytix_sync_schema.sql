-- ============================================================
-- PLYTIX SYNC SCHEMA FOR SUPABASE
-- Migration: 001_plytix_sync_schema
--
-- Aligned with Shopware DumkaSyncPlytix patterns where sensible
-- Designed for Channel-based bulk sync + API enrichment
-- ============================================================

-- ============================================================
-- CORE TABLES
-- ============================================================

-- Product Families (sync first for FK integrity)
CREATE TABLE IF NOT EXISTS plytix_families (
    id TEXT PRIMARY KEY,                    -- Plytix family ID (MongoDB ObjectId)
    label TEXT UNIQUE NOT NULL,             -- Snake_case identifier (e.g., 'lmi_pd')
    name TEXT,                              -- Human-readable name
    parent_id TEXT REFERENCES plytix_families(id) ON DELETE SET NULL,

    -- Family configuration (from API)
    attribute_labels TEXT[],                -- Attributes linked to this family
    raw_data JSONB,                         -- Full API response

    -- Sync metadata
    checksum CHAR(32),
    synced_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plytix_families_label ON plytix_families(label);
CREATE INDEX IF NOT EXISTS idx_plytix_families_parent ON plytix_families(parent_id);


-- Products (main table)
CREATE TABLE IF NOT EXISTS plytix_products (
    id TEXT PRIMARY KEY,                    -- Plytix product ID (MongoDB ObjectId)

    -- Core identifiers
    sku TEXT UNIQUE,
    label TEXT,                             -- Product name/title
    gtin TEXT,

    -- Flexible identifiers (MPN, MNO vary by customer)
    mpn TEXT,                               -- Manufacturer Part Number
    mno TEXT,                               -- Manufacturer Number (if different)

    -- Hierarchy (from Channel: "1 | Family", "2 | Parent", "3 | Child")
    sku_level INTEGER,                      -- 1=Family, 2=Parent, 3=Child
    sku_level_label TEXT,                   -- "Family", "Parent", "Child"
    group_id TEXT,                          -- For parent/variant grouping

    -- Family relationship
    family_label TEXT,                      -- From Channel: "LMI-PD"
    family_id TEXT REFERENCES plytix_families(id) ON DELETE SET NULL,

    -- Parent/Variant relationship
    parent_id TEXT REFERENCES plytix_products(id) ON DELETE SET NULL,
    product_type TEXT,                      -- PARENT, VARIANT, STANDALONE (from API)
    product_level INTEGER,                  -- Plytix hierarchy level (from API)

    -- Inheritance tracking (populated on-demand via API)
    overwritten_attributes TEXT[],          -- NULL = not fetched; [] = fetched, none overwritten
    inheritance_fetched_at TIMESTAMPTZ,

    -- All attributes as JSONB (flexible schema)
    raw_attributes JSONB NOT NULL DEFAULT '{}',

    -- Key extracted fields (for indexing/querying)
    status TEXT,                            -- Plytix status (e.g., "Completed")
    main_image TEXT,
    thumbnail TEXT,

    -- Arrays
    categories TEXT[],
    variant_skus TEXT[],                    -- Child SKUs (from Channel "Variants" field)

    -- Timestamps from Plytix
    plytix_created_at TIMESTAMPTZ,
    plytix_modified_at TIMESTAMPTZ,

    -- Sync metadata
    checksum CHAR(32),                      -- MD5 for change detection
    channel_synced_at TIMESTAMPTZ,          -- When imported from channel
    api_enriched_at TIMESTAMPTZ,            -- When enriched via API
    synced_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_plytix_products_sku ON plytix_products(sku);
CREATE INDEX IF NOT EXISTS idx_plytix_products_mpn ON plytix_products(mpn);
CREATE INDEX IF NOT EXISTS idx_plytix_products_mno ON plytix_products(mno);
CREATE INDEX IF NOT EXISTS idx_plytix_products_gtin ON plytix_products(gtin);
CREATE INDEX IF NOT EXISTS idx_plytix_products_sku_level ON plytix_products(sku_level);
CREATE INDEX IF NOT EXISTS idx_plytix_products_group_id ON plytix_products(group_id);
CREATE INDEX IF NOT EXISTS idx_plytix_products_family_label ON plytix_products(family_label);
CREATE INDEX IF NOT EXISTS idx_plytix_products_family_id ON plytix_products(family_id);
CREATE INDEX IF NOT EXISTS idx_plytix_products_parent_id ON plytix_products(parent_id);
CREATE INDEX IF NOT EXISTS idx_plytix_products_status ON plytix_products(status);
CREATE INDEX IF NOT EXISTS idx_plytix_products_modified ON plytix_products(plytix_modified_at);
CREATE INDEX IF NOT EXISTS idx_plytix_products_raw_attrs ON plytix_products USING GIN(raw_attributes);


-- Attributes metadata (from API)
CREATE TABLE IF NOT EXISTS plytix_attributes (
    id TEXT PRIMARY KEY,                    -- Plytix attribute ID (or label if no ID)
    label TEXT UNIQUE NOT NULL,             -- Snake_case identifier
    name TEXT,                              -- Human-readable name

    -- Attribute configuration
    attribute_type TEXT,                    -- text, number, select, multiselect, etc.
    is_system BOOLEAN DEFAULT FALSE,
    options JSONB,                          -- For select/multiselect: available values

    raw_data JSONB,

    -- Sync metadata
    checksum CHAR(32),
    synced_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plytix_attributes_label ON plytix_attributes(label);
CREATE INDEX IF NOT EXISTS idx_plytix_attributes_type ON plytix_attributes(attribute_type);


-- ============================================================
-- ASSET MANAGEMENT
-- ============================================================

CREATE TABLE IF NOT EXISTS plytix_assets (
    id TEXT PRIMARY KEY,                    -- Plytix asset ID
    filename TEXT NOT NULL,
    title TEXT,

    -- File metadata
    content_type TEXT,                      -- MIME type
    extension TEXT,
    file_size INTEGER,

    -- URLs
    url TEXT,
    thumbnail TEXT,

    -- Sync metadata
    checksum CHAR(32),
    synced_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plytix_assets_filename ON plytix_assets(filename);


-- Product-Asset junction
CREATE TABLE IF NOT EXISTS plytix_product_assets (
    product_id TEXT NOT NULL REFERENCES plytix_products(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES plytix_assets(id) ON DELETE CASCADE,
    asset_type TEXT,                        -- 'main_image', 'alt_image', 'document', 'datasheet', etc.
    position INTEGER DEFAULT 0,

    PRIMARY KEY (product_id, asset_id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plytix_product_assets_type ON plytix_product_assets(asset_type);


-- ============================================================
-- SYNC MANAGEMENT
-- ============================================================

CREATE TABLE IF NOT EXISTS plytix_sync_log (
    id SERIAL PRIMARY KEY,
    sync_type TEXT NOT NULL,                -- 'channel', 'families', 'attributes', 'inheritance'
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    status TEXT DEFAULT 'running',          -- 'running', 'completed', 'failed'

    -- Stats
    records_processed INTEGER DEFAULT 0,
    records_created INTEGER DEFAULT 0,
    records_updated INTEGER DEFAULT 0,
    records_skipped INTEGER DEFAULT 0,      -- Skipped due to matching checksum

    -- For delta sync
    filter_modified_since TIMESTAMPTZ,

    -- Source info
    channel_url TEXT,                       -- Channel URL if applicable

    -- Error tracking
    error_message TEXT,
    error_details JSONB,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plytix_sync_log_type ON plytix_sync_log(sync_type);
CREATE INDEX IF NOT EXISTS idx_plytix_sync_log_status ON plytix_sync_log(status);
CREATE INDEX IF NOT EXISTS idx_plytix_sync_log_started ON plytix_sync_log(started_at DESC);


-- Queue for on-demand inheritance fetching
CREATE TABLE IF NOT EXISTS plytix_inheritance_queue (
    id SERIAL PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES plytix_products(id) ON DELETE CASCADE,
    priority INTEGER DEFAULT 0,             -- Higher = fetch first
    status TEXT DEFAULT 'pending',          -- 'pending', 'fetching', 'completed', 'failed'
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    fetched_at TIMESTAMPTZ,
    error_message TEXT,

    UNIQUE(product_id)
);

CREATE INDEX IF NOT EXISTS idx_plytix_inheritance_queue_status ON plytix_inheritance_queue(status, priority DESC);


-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION plytix_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply triggers (drop first to make migration idempotent)
DROP TRIGGER IF EXISTS plytix_products_timestamp ON plytix_products;
CREATE TRIGGER plytix_products_timestamp
    BEFORE UPDATE ON plytix_products
    FOR EACH ROW EXECUTE FUNCTION plytix_update_timestamp();

DROP TRIGGER IF EXISTS plytix_families_timestamp ON plytix_families;
CREATE TRIGGER plytix_families_timestamp
    BEFORE UPDATE ON plytix_families
    FOR EACH ROW EXECUTE FUNCTION plytix_update_timestamp();

DROP TRIGGER IF EXISTS plytix_attributes_timestamp ON plytix_attributes;
CREATE TRIGGER plytix_attributes_timestamp
    BEFORE UPDATE ON plytix_attributes
    FOR EACH ROW EXECUTE FUNCTION plytix_update_timestamp();

DROP TRIGGER IF EXISTS plytix_assets_timestamp ON plytix_assets;
CREATE TRIGGER plytix_assets_timestamp
    BEFORE UPDATE ON plytix_assets
    FOR EACH ROW EXECUTE FUNCTION plytix_update_timestamp();


-- ============================================================
-- VIEWS
-- ============================================================

-- Products with computed inheritance status
CREATE OR REPLACE VIEW plytix_products_extended AS
SELECT
    p.*,
    f.name AS family_name,
    f.attribute_labels AS family_attribute_labels,
    CASE
        WHEN p.overwritten_attributes IS NOT NULL THEN 'fetched'
        WHEN iq.status = 'pending' THEN 'queued'
        WHEN iq.status = 'fetching' THEN 'fetching'
        ELSE 'not_fetched'
    END AS inheritance_status
FROM plytix_products p
LEFT JOIN plytix_families f ON f.id = p.family_id
LEFT JOIN plytix_inheritance_queue iq ON iq.product_id = p.id;


-- Recent sync activity
CREATE OR REPLACE VIEW plytix_sync_recent AS
SELECT
    sync_type,
    status,
    started_at,
    completed_at,
    EXTRACT(EPOCH FROM (COALESCE(completed_at, NOW()) - started_at)) AS duration_seconds,
    records_processed,
    records_created,
    records_updated,
    records_skipped,
    error_message
FROM plytix_sync_log
ORDER BY started_at DESC
LIMIT 20;


-- ============================================================
-- HELPER FUNCTION: Check if attribute is inherited
-- ============================================================

-- Usage: SELECT plytix_is_inherited('product_id_here', 'head_material');
-- Returns: TRUE (inherited), FALSE (overwritten), NULL (not yet fetched)
CREATE OR REPLACE FUNCTION plytix_is_inherited(
    p_product_id TEXT,
    p_attribute_label TEXT
) RETURNS BOOLEAN AS $$
DECLARE
    v_overwritten TEXT[];
BEGIN
    SELECT overwritten_attributes INTO v_overwritten
    FROM plytix_products WHERE id = p_product_id;

    IF v_overwritten IS NULL THEN
        RETURN NULL;  -- Not yet fetched
    END IF;

    -- Plytix stores as 'attributes.label' format
    -- If attribute is NOT in overwritten array, it's inherited
    RETURN NOT (('attributes.' || p_attribute_label) = ANY(v_overwritten));
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- COMMENTS
-- ============================================================

COMMENT ON TABLE plytix_products IS 'Products synced from Plytix Channel export';
COMMENT ON TABLE plytix_families IS 'Product families from Plytix API';
COMMENT ON TABLE plytix_attributes IS 'Attribute metadata from Plytix API';
COMMENT ON TABLE plytix_sync_log IS 'Sync operation history for debugging';
COMMENT ON TABLE plytix_inheritance_queue IS 'Queue for on-demand inheritance data fetching';

COMMENT ON COLUMN plytix_products.raw_attributes IS 'All attributes from Channel export as JSONB';
COMMENT ON COLUMN plytix_products.overwritten_attributes IS 'Array of explicitly set attributes (not inherited). NULL means not yet fetched from API.';
COMMENT ON COLUMN plytix_products.checksum IS 'MD5 hash for change detection - skip update if unchanged';
COMMENT ON COLUMN plytix_products.sku_level IS '1=Family, 2=Parent, 3=Child (parsed from Channel SKU Level field)';

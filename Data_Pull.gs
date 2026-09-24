/**
 * Promo Log 2.0 - DATA PULL
 *
 * Ten plik jest odpowiedzialny wyłącznie za przygotowanie referencyjnych danych
 * dla Master Log. Ciężkie query BigQuery NIE są wykonywane podczas tworzenia
 * ani przeliczania promocji.
 *
 * Harmonogram docelowy:
 * - Partners: raz w tygodniu
 * - Matrix: raz w miesiącu
 *
 * Funkcje ręczne:
 * - refreshPartners()
 * - refreshMatrix()
 * - refreshAllReferenceData()
 * - setupDataPullTriggers()
 */

var DATA_PULL_PROJECT_ID = 'dhub-glovo';
var DATA_PULL_PARTNERS_SHEET = 'Partners';
var DATA_PULL_MATRIX_SHEET = 'Matrix';
var DATA_PULL_STATUS_SHEET = 'Data_Pull_Status';
var DATA_PULL_PARTNER_AM_HEADER = 'Account Manager';
var DATA_PULL_PARTNER_AM_SOURCE_URL = 'https://docs.google.com/spreadsheets/d/1zrTCU_2Vg5NSMM08nwUbLyxb_iAl-3NITt__JjCPDKE/edit?gid=1233870954#gid=1233870954';

var DATA_PULL_PARTNERS_QUERY = `WITH stores AS (
    SELECT DISTINCT
        CAST(store_id AS STRING) AS store_id,
        CASE
            WHEN store_name LIKE '%BAFRA%' OR store_name LIKE '%Bafra%' THEN 'BAFRA Kebabs'
            WHEN store_name IN ("McDonald's", 'McDonalds') THEN "McDonald's"
            WHEN store_name = 'KFC' THEN 'KFC'
            WHEN store_name IN ('Zahir Kebab', 'Zahid Kebab', 'Noor Kebab', 'Ryżowa Buła', 'Rollo Pizza Express') THEN 'Zahir Kebab'
            WHEN store_name IN ('Pizza Hut', 'Zapiekarony od Pizza Hut') THEN 'Pizza Hut'
            WHEN store_name LIKE 'Domino%Pizza%' THEN "Domino's Pizza"
            WHEN store_name IN ('Kebab King', 'BOX KEBAB', 'Zana Restaurant & Lounge Bar', 'Kebab King Premium') THEN 'Kebab King'
            WHEN store_name IN ('MAX Premium Burgers', 'Zielone Menu z MAX') THEN 'MAX Premium Burgers'
            WHEN store_name IN ('Pasibus', 'Pasibus Galeria Arkadia') THEN 'Pasibus'
            WHEN store_name = 'Starbucks' THEN 'Starbucks'
            WHEN store_name IN ('Subway by AMIC Energy', 'Pizza Sbarro by AMIC Energy') THEN 'Subway by AMIC Energy'
            WHEN store_name IN ('Berlin Döner Kebap', 'Berlin Doner') THEN 'Berlin Döner Kebap'
            WHEN store_name IN ('Thai Wok', 'Tuk Tuk', 'Tajska Micha by Thai Wok', 'Ramen & Udon by Thai Wok') THEN 'Thai Wok'
            WHEN store_name IN ('T-Pizza (wcześniej Telepizza)', 'T-Pizza', 'Telepizza') THEN 'T-Pizza (wcześniej Telepizza)'
            WHEN store_name IN ('Sphinx', 'Chłopskie Jadło', 'The Burgers') THEN 'Sphinx'
            WHEN store_name IN ('Salad Story', 'WrapMe!') THEN 'Salad Story'
            WHEN store_name IN ('North Fish', 'John Burg') THEN 'North Fish'
            WHEN store_name IN ('Holy Taco', 'Mniamciu', 'Sznyclove', 'Przysmaki Alushy', 'Prokuratura', 'Grube Pierogi', 'Vito Calzone', 'Rano Podano', 'Wege Gang', 'Just Burgers') THEN 'Rebel Tang'
            WHEN store_name = 'Green Caffè Nero' THEN 'Green Caffè Nero'
            WHEN store_name = 'Papa Johns Pizza' THEN 'Papa Johns Pizza'
            WHEN store_name IN ('Costa Coffee', 'SO! COFFEE') THEN 'Costa Coffee'
            WHEN store_name = 'Bobby Burger' THEN 'Bobby Burger'
            WHEN LOWER(store_name) LIKE 'am am kebab%' THEN 'AM AM Kebab'
            WHEN store_name LIKE 'Pizzeria 105%' THEN 'Pizzeria 105'
            WHEN store_name LIKE '%Osama%' THEN 'Osama Sushi'
            WHEN LOWER(store_name) LIKE LOWER('KOKU%SUSHI%') THEN 'Koku Sushi'
            WHEN LOWER(store_name) LIKE '%berlin%d%ner%' THEN 'Berlin Döner Kebap'
            WHEN LOWER(store_name) LIKE LOWER('Subway%') THEN 'Subway'
            WHEN LOWER(store_name) LIKE LOWER('KEBAB%SUPER%KING') THEN 'Kebab Super King'
            WHEN store_name LIKE '%Solleim%' THEN 'Solleim'
            ELSE TRIM(store_name)
        END AS store_name
    FROM \`fulfillment-dwh-production.curated_data_shared_glovo.partner__stores\`
    WHERE p_snapshot_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
),
daily AS (
    SELECT
        CAST(t.store_address_id AS STRING) AS store_address_id,
        CAST(t.store_id AS STRING) AS store_id,
        t.segmentation AS segmentation,
        t.p_creation_date AS d,
        t.city_code AS city_code,
        SUM(t.DH_GMV) AS gmv,
        SUM(t.total_orders) AS orders,
        MAX(CASE WHEN COALESCE(t.promo_orders,0) > 0
                   OR COALESCE(t.total_promotool_discounts,0) > 0
                 THEN 1 ELSE 0 END) AS is_promo_day
    FROM \`fulfillment-dwh-production.curated_data_shared_glovo.promos_okr__promos_okr_tracker_v2\` AS t
    WHERE t.country_code = 'PL'
      AND t.segmentation <> 'Q-Commerce'
      AND t.p_creation_date >= DATE_SUB(DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)), INTERVAL 90 DAY)
      AND t.p_creation_date < DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
    GROUP BY 1, 2, 3, 4, 5
),
clean_ranked AS (
    SELECT
        store_address_id, store_id, segmentation, d, city_code, gmv, orders,
        ROW_NUMBER() OVER (PARTITION BY store_address_id ORDER BY d DESC) AS rn
    FROM daily
    WHERE is_promo_day = 0 AND orders > 0
),
clean_address_ids AS (
    SELECT DISTINCT store_address_id FROM clean_ranked
),
fallback_ranked AS (
    -- Partners running a promo on every single day in the 90-day window have
    -- zero "clean" (non-promo) days and would otherwise never qualify for
    -- Partners. Fall back to their raw, promo-inclusive daily performance so
    -- they still show up; this baseline is promo-inflated and flagged via
    -- baseline_quality = 'PROMO-ONLY' below instead of being silently mixed
    -- into OK/LOW/NONE.
    SELECT
        store_address_id, store_id, segmentation, d, city_code, gmv, orders,
        ROW_NUMBER() OVER (PARTITION BY store_address_id ORDER BY d DESC) AS rn
    FROM daily
    WHERE orders > 0
      AND store_address_id NOT IN (SELECT store_address_id FROM clean_address_ids)
),
combined_ranked AS (
    SELECT *, FALSE AS is_promo_only_fallback FROM clean_ranked
    UNION ALL
    SELECT *, TRUE AS is_promo_only_fallback FROM fallback_ranked
),
last56_per_address AS (
    SELECT
        store_address_id, store_id,
        ANY_VALUE(segmentation) AS segmentation,
        AVG(CASE WHEN city_code IN ('WAW', 'KRA', 'WRO', 'POZ') THEN gmv ELSE 0 END) AS addr_daily_top4_gmv,
        AVG(gmv) AS addr_daily_gmv,
        AVG(orders) AS addr_daily_orders,
        COUNT(*) AS clean_days,
        LOGICAL_OR(is_promo_only_fallback) AS is_promo_only_baseline
    FROM combined_ranked
    WHERE rn <= 56
    GROUP BY 1, 2
),
brand_segment AS (
    SELECT store_name, segmentation
    FROM (
        SELECT s.store_name, a.segmentation,
               ROW_NUMBER() OVER (PARTITION BY s.store_name ORDER BY COUNT(*) DESC) AS rn
        FROM last56_per_address a
        JOIN stores s ON a.store_id = s.store_id
        GROUP BY 1, 2
    )
    WHERE rn = 1
)
SELECT
    s.store_name,
    bs.segmentation,
    ROUND(SUM(a.addr_daily_gmv), 2) AS daily_gmv_eur,
    ROUND(SUM(a.addr_daily_orders), 1) AS daily_orders,
    ROUND(SAFE_DIVIDE(SUM(a.addr_daily_gmv), NULLIF(SUM(a.addr_daily_orders),0)), 2) AS aov_eur,
    COUNT(DISTINCT a.store_address_id) AS n_locations,
    ROUND(AVG(a.clean_days), 0) AS avg_clean_days,
    CASE WHEN LOGICAL_OR(a.is_promo_only_baseline) THEN 'PROMO-ONLY'
         WHEN AVG(a.clean_days) >= 42 THEN 'OK'
         WHEN AVG(a.clean_days) >= 14 THEN 'LOW'
         ELSE 'NONE' END AS baseline_quality,
    ROUND(SAFE_DIVIDE(SUM(a.addr_daily_top4_gmv), NULLIF(SUM(a.addr_daily_gmv), 0)), 4) AS top4cities_share,
    STRING_AGG(DISTINCT CAST(a.store_id AS STRING), ', ' ORDER BY CAST(a.store_id AS STRING)) AS store_id
FROM last56_per_address a
JOIN stores s ON a.store_id = s.store_id
LEFT JOIN brand_segment bs ON s.store_name = bs.store_name
GROUP BY 1, 2
HAVING SUM(a.addr_daily_orders) > 1
ORDER BY daily_gmv_eur DESC`;

var DATA_PULL_MATRIX_QUERY = `WITH promo_definition AS (
    SELECT
        store_address_id, partner_promotion_started_at, partner_promotion_ended_at, partner_promotion_type,
        CASE WHEN COUNT(DISTINCT partner_promotion_id) > 1 AND MAX(CAST(partner_promotion_is_prime AS INT64)) = 1
             THEN 'BPP' ELSE 'Standard' END as promo_strategy,
        COALESCE(MAX(CASE WHEN partner_promotion_is_prime THEN partner_promotion_id END), MAX(partner_promotion_id)) as final_promotion_id,
        MAX(partner_promotion_pct) as max_pct, MIN(partner_promotion_pct) as min_pct, MAX(mbs_eur) as mbs_eur,
        DATE_DIFF(partner_promotion_ended_at, partner_promotion_started_at, DAY) + 1 as duration,
        DATE_SUB(partner_promotion_started_at, INTERVAL (DATE_DIFF(partner_promotion_ended_at, partner_promotion_started_at, DAY) + 1) DAY) as baseline_start,
        DATE_SUB(partner_promotion_started_at, INTERVAL 1 DAY) as baseline_end
    FROM (
        SELECT pp.partner_promotion_id, pp.partner_promotion_type, pp.partner_promotion_is_prime, pp.partner_promotion_pct,
            DATE(pp.partner_promotion_started_at) as partner_promotion_started_at,
            DATE(pp.partner_promotion_ended_at) as partner_promotion_ended_at,
            pp.partner_promotion_minimum_basket_size_in_cents / 100 as mbs_eur,
            CAST(od.store_address_id AS STRING) as store_address_id
        FROM \`fulfillment-dwh-production.curated_data_shared_glovo.discounts__discounts_partner_promotions\` AS pp
        INNER JOIN \`fulfillment-dwh-production.curated_data_shared_glovo.pricing_discounts__pricing_discounts\` AS pd ON pd.partner_promotion_id = pp.partner_promotion_id
        INNER JOIN \`fulfillment-dwh-production.curated_data_shared_glovo.order_descriptors__order_descriptors_v3\` AS od ON CAST(od.order_id AS STRING) = CAST(pd.order_id AS STRING)
        WHERE DATE(pp.partner_promotion_started_at) >= '2024-05-01' AND DATE(pp.partner_promotion_ended_at) < CURRENT_DATE()
          AND (pp.segment_id <> 36692 OR pp.segment_id IS NULL)
    )
    GROUP BY 1, 2, 3, 4
),
daily_performance AS (
    SELECT CAST(store_address_id AS STRING) as store_address_id, CAST(store_id AS STRING) as store_id,
        city_code, segmentation, p_creation_date, total_orders, DH_GMV, total_promotool_discounts, prime_promo_orders, promo_orders,
        (total_promotool_discounts_prime_partner + total_promotool_discounts_prime_glovo + total_promotool_discounts_prime_3rd_party) as cost_prime_only
    FROM \`fulfillment-dwh-production.curated_data_shared_glovo.promos_okr__promos_okr_tracker_v2\`
    WHERE country_code = 'PL' AND p_creation_date >= '2024-04-01' AND segmentation <> 'Q-Commerce'
),
store_metadata AS (
    SELECT DISTINCT CAST(store_id AS STRING) as store_id, store_name, si.store_business_unit as tag
    FROM \`fulfillment-dwh-production.curated_data_shared_glovo.partner__stores\` AS si
    WHERE p_snapshot_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
),
combined_data AS (
    SELECT p.store_address_id, p.partner_promotion_type, p.promo_strategy, p.max_pct, p.duration,
        s.store_id, s.segmentation, s.city_code, m.tag,
        SUM(CASE WHEN s.p_creation_date BETWEEN p.partner_promotion_started_at AND p.partner_promotion_ended_at THEN s.total_orders ELSE 0 END) as total_store_orders_during_promo,
        SUM(CASE WHEN s.p_creation_date BETWEEN p.partner_promotion_started_at AND p.partner_promotion_ended_at THEN s.DH_GMV ELSE 0 END) as total_store_gmv_during_promo,
        SUM(CASE WHEN s.p_creation_date BETWEEN p.partner_promotion_started_at AND p.partner_promotion_ended_at THEN s.promo_orders ELSE 0 END) as total_promo_orders_sum,
        SUM(CASE WHEN s.p_creation_date BETWEEN p.partner_promotion_started_at AND p.partner_promotion_ended_at THEN s.prime_promo_orders ELSE 0 END) as prime_promo_orders_sum,
        SUM(CASE WHEN s.p_creation_date BETWEEN p.partner_promotion_started_at AND p.partner_promotion_ended_at THEN s.total_promotool_discounts ELSE 0 END) as total_promo_cost,
        SUM(CASE WHEN s.p_creation_date BETWEEN p.baseline_start AND p.baseline_end THEN s.total_orders ELSE 0 END) as baseline_orders,
        SUM(CASE WHEN s.p_creation_date BETWEEN p.baseline_start AND p.baseline_end THEN s.DH_GMV ELSE 0 END) as baseline_gmv
    FROM promo_definition p
    INNER JOIN daily_performance s ON p.store_address_id = s.store_address_id
    LEFT JOIN store_metadata m ON s.store_id = m.store_id
    WHERE s.p_creation_date BETWEEN p.baseline_start AND p.partner_promotion_ended_at
    GROUP BY 1,2,3,4,5,6,7,8,9
),
metrics AS (
  SELECT
    segmentation, partner_promotion_type,
    CASE WHEN max_pct IS NULL OR max_pct = 0 THEN '0 (none)'
         WHEN max_pct <= 15 THEN '1-15' WHEN max_pct <= 20 THEN '16-20'
         WHEN max_pct <= 25 THEN '21-25' WHEN max_pct <= 30 THEN '26-30'
         WHEN max_pct <= 40 THEN '31-40' ELSE '41+' END AS depth_bucket,
    SAFE_DIVIDE(total_store_gmv_during_promo, baseline_gmv) AS uplift_mult,
    SAFE_DIVIDE(total_store_orders_during_promo, NULLIF(baseline_orders,0)) AS orders_mult,
    SAFE_DIVIDE(total_promo_cost, NULLIF(total_store_gmv_during_promo,0)) AS cost_intensity,
    SAFE_DIVIDE(total_promo_cost, NULLIF(total_promo_orders_sum,0)) AS cost_per_promo_order,
    SAFE_DIVIDE(total_promo_orders_sum, NULLIF(total_store_orders_during_promo,0)) AS penetration,
    SAFE_DIVIDE(total_store_gmv_during_promo - baseline_gmv, NULLIF(total_promo_cost,0)) AS roi,
    SAFE_DIVIDE(SAFE_DIVIDE(total_promo_cost, NULLIF(max_pct/100,0)), NULLIF(total_store_gmv_during_promo + total_promo_cost,0)) AS coverage,
    IF(promo_strategy='BPP', SAFE_DIVIDE(prime_promo_orders_sum, NULLIF(total_promo_orders_sum,0)), NULL) AS prime_share
  FROM combined_data
  WHERE total_store_gmv_during_promo > 0 AND baseline_orders >= 5 AND total_promo_orders_sum > 0
),
b_l1 AS (
  SELECT segmentation, partner_promotion_type, depth_bucket,
    APPROX_QUANTILES(uplift_mult,100)[OFFSET(5)] AS uplift_mult_lo,
    APPROX_QUANTILES(uplift_mult,100)[OFFSET(95)] AS uplift_mult_hi,
    APPROX_QUANTILES(orders_mult,100)[OFFSET(5)] AS orders_mult_lo,
    APPROX_QUANTILES(orders_mult,100)[OFFSET(95)] AS orders_mult_hi,
    APPROX_QUANTILES(cost_intensity,100)[OFFSET(5)] AS cost_intensity_lo,
    APPROX_QUANTILES(cost_intensity,100)[OFFSET(95)] AS cost_intensity_hi,
    APPROX_QUANTILES(cost_per_promo_order,100)[OFFSET(5)] AS cost_per_promo_order_lo,
    APPROX_QUANTILES(cost_per_promo_order,100)[OFFSET(95)] AS cost_per_promo_order_hi,
    APPROX_QUANTILES(penetration,100)[OFFSET(5)] AS penetration_lo,
    APPROX_QUANTILES(penetration,100)[OFFSET(95)] AS penetration_hi,
    APPROX_QUANTILES(roi,100)[OFFSET(5)] AS roi_lo,
    APPROX_QUANTILES(roi,100)[OFFSET(95)] AS roi_hi,
    APPROX_QUANTILES(coverage,100)[OFFSET(5)] AS coverage_lo,
    APPROX_QUANTILES(coverage,100)[OFFSET(95)] AS coverage_hi,
    APPROX_QUANTILES(prime_share,100)[OFFSET(5)] AS prime_share_lo,
    APPROX_QUANTILES(prime_share,100)[OFFSET(95)] AS prime_share_hi
  FROM metrics GROUP BY segmentation, partner_promotion_type, depth_bucket
),
b_l2 AS (
  SELECT partner_promotion_type, depth_bucket,
    APPROX_QUANTILES(uplift_mult,100)[OFFSET(5)] AS uplift_mult_lo,
    APPROX_QUANTILES(uplift_mult,100)[OFFSET(95)] AS uplift_mult_hi,
    APPROX_QUANTILES(orders_mult,100)[OFFSET(5)] AS orders_mult_lo,
    APPROX_QUANTILES(orders_mult,100)[OFFSET(95)] AS orders_mult_hi,
    APPROX_QUANTILES(cost_intensity,100)[OFFSET(5)] AS cost_intensity_lo,
    APPROX_QUANTILES(cost_intensity,100)[OFFSET(95)] AS cost_intensity_hi,
    APPROX_QUANTILES(cost_per_promo_order,100)[OFFSET(5)] AS cost_per_promo_order_lo,
    APPROX_QUANTILES(cost_per_promo_order,100)[OFFSET(95)] AS cost_per_promo_order_hi,
    APPROX_QUANTILES(penetration,100)[OFFSET(5)] AS penetration_lo,
    APPROX_QUANTILES(penetration,100)[OFFSET(95)] AS penetration_hi,
    APPROX_QUANTILES(roi,100)[OFFSET(5)] AS roi_lo,
    APPROX_QUANTILES(roi,100)[OFFSET(95)] AS roi_hi,
    APPROX_QUANTILES(coverage,100)[OFFSET(5)] AS coverage_lo,
    APPROX_QUANTILES(coverage,100)[OFFSET(95)] AS coverage_hi,
    APPROX_QUANTILES(prime_share,100)[OFFSET(5)] AS prime_share_lo,
    APPROX_QUANTILES(prime_share,100)[OFFSET(95)] AS prime_share_hi
  FROM metrics GROUP BY partner_promotion_type, depth_bucket
),
b_l3 AS (
  SELECT partner_promotion_type,
    APPROX_QUANTILES(uplift_mult,100)[OFFSET(5)] AS uplift_mult_lo,
    APPROX_QUANTILES(uplift_mult,100)[OFFSET(95)] AS uplift_mult_hi,
    APPROX_QUANTILES(orders_mult,100)[OFFSET(5)] AS orders_mult_lo,
    APPROX_QUANTILES(orders_mult,100)[OFFSET(95)] AS orders_mult_hi,
    APPROX_QUANTILES(cost_intensity,100)[OFFSET(5)] AS cost_intensity_lo,
    APPROX_QUANTILES(cost_intensity,100)[OFFSET(95)] AS cost_intensity_hi,
    APPROX_QUANTILES(cost_per_promo_order,100)[OFFSET(5)] AS cost_per_promo_order_lo,
    APPROX_QUANTILES(cost_per_promo_order,100)[OFFSET(95)] AS cost_per_promo_order_hi,
    APPROX_QUANTILES(penetration,100)[OFFSET(5)] AS penetration_lo,
    APPROX_QUANTILES(penetration,100)[OFFSET(95)] AS penetration_hi,
    APPROX_QUANTILES(roi,100)[OFFSET(5)] AS roi_lo,
    APPROX_QUANTILES(roi,100)[OFFSET(95)] AS roi_hi,
    APPROX_QUANTILES(coverage,100)[OFFSET(5)] AS coverage_lo,
    APPROX_QUANTILES(coverage,100)[OFFSET(95)] AS coverage_hi,
    APPROX_QUANTILES(prime_share,100)[OFFSET(5)] AS prime_share_lo,
    APPROX_QUANTILES(prime_share,100)[OFFSET(95)] AS prime_share_hi
  FROM metrics GROUP BY partner_promotion_type
),
matrix_levels AS (
  SELECT
    m.segmentation AS segmentation,
    m.partner_promotion_type,
    m.depth_bucket AS depth_bucket,
    'seg+type+depth' AS level,
    COUNT(*) AS n,
    APPROX_QUANTILES(IF(uplift_mult BETWEEN b.uplift_mult_lo AND b.uplift_mult_hi, uplift_mult, NULL),100)[OFFSET(50)] AS uplift_mult,
    APPROX_QUANTILES(IF(uplift_mult BETWEEN b.uplift_mult_lo AND b.uplift_mult_hi, uplift_mult, NULL),100)[OFFSET(25)] AS uplift_p25,
    APPROX_QUANTILES(IF(uplift_mult BETWEEN b.uplift_mult_lo AND b.uplift_mult_hi, uplift_mult, NULL),100)[OFFSET(75)] AS uplift_p75,
    APPROX_QUANTILES(IF(orders_mult BETWEEN b.orders_mult_lo AND b.orders_mult_hi, orders_mult, NULL),100)[OFFSET(50)] AS orders_mult,
    APPROX_QUANTILES(IF(cost_intensity BETWEEN b.cost_intensity_lo AND b.cost_intensity_hi, cost_intensity, NULL),100)[OFFSET(50)] AS cost_intensity,
    APPROX_QUANTILES(IF(cost_per_promo_order BETWEEN b.cost_per_promo_order_lo AND b.cost_per_promo_order_hi, cost_per_promo_order, NULL),100)[OFFSET(50)] AS cost_per_promo_order,
    APPROX_QUANTILES(IF(penetration BETWEEN b.penetration_lo AND b.penetration_hi, penetration, NULL),100)[OFFSET(50)] AS penetration,
    APPROX_QUANTILES(IF(roi BETWEEN b.roi_lo AND b.roi_hi, roi, NULL),100)[OFFSET(50)] AS roi,
    APPROX_QUANTILES(IF(coverage BETWEEN b.coverage_lo AND b.coverage_hi, coverage, NULL),100)[OFFSET(50)] AS coverage,
    APPROX_QUANTILES(IF(prime_share BETWEEN b.prime_share_lo AND b.prime_share_hi, prime_share, NULL),100)[OFFSET(50)] AS prime_share
  FROM metrics m JOIN b_l1 b ON m.segmentation=b.segmentation AND m.partner_promotion_type=b.partner_promotion_type AND m.depth_bucket=b.depth_bucket
  GROUP BY 1,2,3,4
  HAVING COUNT(*) >= 30
  UNION ALL
  SELECT
    'ALL' AS segmentation,
    m.partner_promotion_type,
    m.depth_bucket AS depth_bucket,
    'type+depth' AS level,
    COUNT(*) AS n,
    APPROX_QUANTILES(IF(uplift_mult BETWEEN b.uplift_mult_lo AND b.uplift_mult_hi, uplift_mult, NULL),100)[OFFSET(50)] AS uplift_mult,
    APPROX_QUANTILES(IF(uplift_mult BETWEEN b.uplift_mult_lo AND b.uplift_mult_hi, uplift_mult, NULL),100)[OFFSET(25)] AS uplift_p25,
    APPROX_QUANTILES(IF(uplift_mult BETWEEN b.uplift_mult_lo AND b.uplift_mult_hi, uplift_mult, NULL),100)[OFFSET(75)] AS uplift_p75,
    APPROX_QUANTILES(IF(orders_mult BETWEEN b.orders_mult_lo AND b.orders_mult_hi, orders_mult, NULL),100)[OFFSET(50)] AS orders_mult,
    APPROX_QUANTILES(IF(cost_intensity BETWEEN b.cost_intensity_lo AND b.cost_intensity_hi, cost_intensity, NULL),100)[OFFSET(50)] AS cost_intensity,
    APPROX_QUANTILES(IF(cost_per_promo_order BETWEEN b.cost_per_promo_order_lo AND b.cost_per_promo_order_hi, cost_per_promo_order, NULL),100)[OFFSET(50)] AS cost_per_promo_order,
    APPROX_QUANTILES(IF(penetration BETWEEN b.penetration_lo AND b.penetration_hi, penetration, NULL),100)[OFFSET(50)] AS penetration,
    APPROX_QUANTILES(IF(roi BETWEEN b.roi_lo AND b.roi_hi, roi, NULL),100)[OFFSET(50)] AS roi,
    APPROX_QUANTILES(IF(coverage BETWEEN b.coverage_lo AND b.coverage_hi, coverage, NULL),100)[OFFSET(50)] AS coverage,
    APPROX_QUANTILES(IF(prime_share BETWEEN b.prime_share_lo AND b.prime_share_hi, prime_share, NULL),100)[OFFSET(50)] AS prime_share
  FROM metrics m JOIN b_l2 b ON m.partner_promotion_type=b.partner_promotion_type AND m.depth_bucket=b.depth_bucket
  GROUP BY 1,2,3,4
  UNION ALL
  SELECT
    'ALL' AS segmentation,
    m.partner_promotion_type,
    'ALL' AS depth_bucket,
    'type' AS level,
    COUNT(*) AS n,
    APPROX_QUANTILES(IF(uplift_mult BETWEEN b.uplift_mult_lo AND b.uplift_mult_hi, uplift_mult, NULL),100)[OFFSET(50)] AS uplift_mult,
    APPROX_QUANTILES(IF(uplift_mult BETWEEN b.uplift_mult_lo AND b.uplift_mult_hi, uplift_mult, NULL),100)[OFFSET(25)] AS uplift_p25,
    APPROX_QUANTILES(IF(uplift_mult BETWEEN b.uplift_mult_lo AND b.uplift_mult_hi, uplift_mult, NULL),100)[OFFSET(75)] AS uplift_p75,
    APPROX_QUANTILES(IF(orders_mult BETWEEN b.orders_mult_lo AND b.orders_mult_hi, orders_mult, NULL),100)[OFFSET(50)] AS orders_mult,
    APPROX_QUANTILES(IF(cost_intensity BETWEEN b.cost_intensity_lo AND b.cost_intensity_hi, cost_intensity, NULL),100)[OFFSET(50)] AS cost_intensity,
    APPROX_QUANTILES(IF(cost_per_promo_order BETWEEN b.cost_per_promo_order_lo AND b.cost_per_promo_order_hi, cost_per_promo_order, NULL),100)[OFFSET(50)] AS cost_per_promo_order,
    APPROX_QUANTILES(IF(penetration BETWEEN b.penetration_lo AND b.penetration_hi, penetration, NULL),100)[OFFSET(50)] AS penetration,
    APPROX_QUANTILES(IF(roi BETWEEN b.roi_lo AND b.roi_hi, roi, NULL),100)[OFFSET(50)] AS roi,
    APPROX_QUANTILES(IF(coverage BETWEEN b.coverage_lo AND b.coverage_hi, coverage, NULL),100)[OFFSET(50)] AS coverage,
    APPROX_QUANTILES(IF(prime_share BETWEEN b.prime_share_lo AND b.prime_share_hi, prime_share, NULL),100)[OFFSET(50)] AS prime_share
  FROM metrics m JOIN b_l3 b ON m.partner_promotion_type=b.partner_promotion_type
  GROUP BY 1,2,3
),
seg_map AS (
  SELECT CAST(store_id AS STRING) AS store_id, ANY_VALUE(segmentation) AS segmentation
  FROM \`fulfillment-dwh-production.curated_data_shared_glovo.promos_okr__promos_okr_tracker_v2\`
  WHERE country_code = 'PL' AND segmentation <> 'Q-Commerce'
  GROUP BY 1
),
promo_set AS (
  SELECT DISTINCT
    ps.partner_promotion_id,
    CAST(pa.store_address_id AS STRING) AS store_address_id,
    sp.product_id,
    DATE(pp.partner_promotion_started_at) AS promo_start,
    DATE(pp.partner_promotion_ended_at) AS promo_end,
    pp.partner_promotion_type,
    pp.partner_promotion_pct
  FROM \`fulfillment-dwh-production.curated_data_shared_glovo.discounts__discounts_partner_promotion_stores\` ps
  JOIN \`fulfillment-dwh-production.curated_data_shared_glovo.discounts__discounts_partner_promotion_store_addresses\` pa
    ON pa.partner_promotion_store_id = ps.partner_promotion_store_id
  JOIN \`fulfillment-dwh-production.curated_data_shared_glovo.discounts__discounts_partner_promotion_store_products\` sp
    ON sp.partner_promotion_store_id = ps.partner_promotion_store_id
   AND sp.is_valid = TRUE
  JOIN \`fulfillment-dwh-production.curated_data_shared_glovo.discounts__discounts_partner_promotions\` pp
    ON pp.partner_promotion_id = ps.partner_promotion_id
  WHERE DATE(pp.partner_promotion_started_at) >= '2024-05-01'
    AND DATE(pp.partner_promotion_ended_at) < CURRENT_DATE()
    AND pp.partner_promotion_type IN ('PERCENTAGE_DISCOUNT','BASKET_PERCENTAGE')
    AND sp.product_id IS NOT NULL
),
windows AS (
  SELECT *,
    DATE_SUB(promo_start, INTERVAL DATE_DIFF(promo_end, promo_start, DAY) + 1 DAY) AS base_start,
    DATE_SUB(promo_start, INTERVAL 1 DAY) AS base_end
  FROM promo_set
),
prod_sales AS (
  SELECT
    w.partner_promotion_id, w.store_address_id, w.partner_promotion_type, w.partner_promotion_pct,
    SUM(IF(bp.p_creation_date BETWEEN w.promo_start AND w.promo_end, bp.quantity_delivered_decimal, 0)) AS promo_qty,
    SUM(IF(bp.p_creation_date BETWEEN w.base_start AND w.base_end, bp.quantity_delivered_decimal, 0)) AS base_qty
  FROM windows w
  JOIN \`fulfillment-dwh-production.curated_data_shared_glovo.bought_products_looker__bought_products\` bp
    ON CAST(bp.store_address_id AS STRING) = w.store_address_id
   AND bp.product_id = w.product_id
   AND bp.order_country_code = 'PL'
   AND bp.p_creation_date BETWEEN w.base_start AND w.promo_end
  GROUP BY 1,2,3,4
),
pp_metrics AS (
  SELECT
    sm.segmentation,
    s.partner_promotion_type,
    CASE WHEN s.partner_promotion_pct IS NULL OR s.partner_promotion_pct = 0 THEN '0 (none)'
         WHEN s.partner_promotion_pct <= 15 THEN '1-15' WHEN s.partner_promotion_pct <= 20 THEN '16-20'
         WHEN s.partner_promotion_pct <= 25 THEN '21-25' WHEN s.partner_promotion_pct <= 30 THEN '26-30'
         WHEN s.partner_promotion_pct <= 40 THEN '31-40' ELSE '41+' END AS depth_bucket,
    SAFE_DIVIDE(s.promo_qty, NULLIF(s.base_qty,0)) AS pp_uplift
  FROM prod_sales s
  LEFT JOIN seg_map sm ON sm.store_address_id = s.store_address_id
  WHERE s.base_qty > 0
),
pp_b1 AS (
  SELECT segmentation, partner_promotion_type, depth_bucket,
    APPROX_QUANTILES(pp_uplift,100)[OFFSET(5)] AS lo,
    APPROX_QUANTILES(pp_uplift,100)[OFFSET(95)] AS hi
  FROM pp_metrics GROUP BY 1,2,3
),
pp_b2 AS (
  SELECT partner_promotion_type, depth_bucket,
    APPROX_QUANTILES(pp_uplift,100)[OFFSET(5)] AS lo,
    APPROX_QUANTILES(pp_uplift,100)[OFFSET(95)] AS hi
  FROM pp_metrics GROUP BY 1,2
),
pp_b3 AS (
  SELECT partner_promotion_type,
    APPROX_QUANTILES(pp_uplift,100)[OFFSET(5)] AS lo,
    APPROX_QUANTILES(pp_uplift,100)[OFFSET(95)] AS hi
  FROM pp_metrics GROUP BY 1
),
pp_seg AS (
  SELECT m.segmentation, m.partner_promotion_type, m.depth_bucket,
    APPROX_QUANTILES(IF(m.pp_uplift BETWEEN b.lo AND b.hi, m.pp_uplift, NULL),100)[OFFSET(50)] AS pp_uplift
  FROM pp_metrics m JOIN pp_b1 b USING (segmentation, partner_promotion_type, depth_bucket)
  GROUP BY 1,2,3
),
pp_td AS (
  SELECT m.partner_promotion_type, m.depth_bucket,
    APPROX_QUANTILES(IF(m.pp_uplift BETWEEN b.lo AND b.hi, m.pp_uplift, NULL),100)[OFFSET(50)] AS pp_uplift
  FROM pp_metrics m JOIN pp_b2 b USING (partner_promotion_type, depth_bucket)
  GROUP BY 1,2
),
pp_type AS (
  SELECT m.partner_promotion_type,
    APPROX_QUANTILES(IF(m.pp_uplift BETWEEN b.lo AND b.hi, m.pp_uplift, NULL),100)[OFFSET(50)] AS pp_uplift
  FROM pp_metrics m JOIN pp_b3 b USING (partner_promotion_type)
  GROUP BY 1
)
SELECT
  CONCAT(ml.segmentation,'|',ml.partner_promotion_type,'|',ml.depth_bucket) AS key,
  ml.segmentation, ml.partner_promotion_type, ml.depth_bucket, ml.level, ml.n,
  ml.uplift_mult, ml.uplift_p25, ml.uplift_p75, ml.orders_mult,
  ml.cost_intensity, ml.cost_per_promo_order, ml.penetration, ml.roi, ml.coverage, ml.prime_share,
  COALESCE(pp_seg.pp_uplift, pp_td.pp_uplift, pp_type.pp_uplift) AS promo_products_uplift_multiplier
FROM matrix_levels ml
LEFT JOIN pp_seg ON pp_seg.segmentation = ml.segmentation
                AND pp_seg.partner_promotion_type = ml.partner_promotion_type
                AND pp_seg.depth_bucket = ml.depth_bucket
LEFT JOIN pp_td ON pp_td.partner_promotion_type = ml.partner_promotion_type
                AND pp_td.depth_bucket = ml.depth_bucket
LEFT JOIN pp_type ON pp_type.partner_promotion_type = ml.partner_promotion_type
ORDER BY ml.partner_promotion_type, ml.segmentation, ml.depth_bucket`;

function dataPullRunBigQuery_(query, label) {
  var request = BigQuery.newQueryRequest();
  request.query = query;
  request.useLegacySql = false;

  var result = BigQuery.Jobs.query(request, DATA_PULL_PROJECT_ID);
  var jobId = result.jobReference && result.jobReference.jobId;
  if (!jobId) throw new Error(label + ': BigQuery did not return a job ID.');

  var maxWaitMs = 330000; // 5.5 min, below Apps Script's usual execution limit.
  var pollEveryMs = 5000;
  var started = Date.now();

  while (true) {
    var job = BigQuery.Jobs.get(DATA_PULL_PROJECT_ID, jobId);
    var state = job.status && job.status.state;

    if (state === 'DONE') {
      if (job.status.errorResult) {
        throw new Error(label + ': ' + JSON.stringify(job.status.errorResult));
      }
      break;
    }

    if (Date.now() - started > maxWaitMs) {
      throw new Error(label + ': query did not finish within 5.5 minutes. Job ID: ' + jobId);
    }

    Utilities.sleep(pollEveryMs);
  }

  var allRows = [];
  var pageToken = null;
  var schema = null;

  do {
    var options = {maxResults: 10000};
    if (pageToken) options.pageToken = pageToken;

    var page = BigQuery.Jobs.getQueryResults(DATA_PULL_PROJECT_ID, jobId, options);
    if (!schema && page.schema) schema = page.schema;
    allRows = allRows.concat(page.rows || []);
    pageToken = page.pageToken || null;
  } while (pageToken);

  var headers = (schema && schema.fields ? schema.fields : []).map(function(field) {
    return field.name;
  });

  var values = allRows.map(function(row) {
    return row.f.map(function(cell) {
      return cell && cell.v !== undefined ? cell.v : null;
    });
  });

  return {headers: headers, values: values, jobId: jobId};
}

function dataPullAddPartnerAMFormula_(sheet, result) {
  // Partners A = Partner Name.
  // J = Account Manager from daily-refreshed PL (adjusted to SMB).
  // K = original Team matched by AM email from Teams Exctract.
  // L = normalized Team Group used by Pitching Overview:
  //     Big Chain / Regions / SMB.
  // M = Store Address ID(s) from the Partners BigQuery source.
  //
  // IMPORTANT:
  // The Partners query is at Partner/brand level, so a partner can have
  // multiple Store Address IDs. M therefore contains a comma-separated list
  // of all Store Address IDs belonging to that Partner.
  var maxRows = sheet.getMaxRows();
  var rowCount = result && result.values ? result.values.length : 0;

  // The 10th query column is store_address_id. Keep it before J-L are rebuilt.
  var storeAddressIds = [];
  for (var i = 0; i < rowCount; i++) {
    storeAddressIds.push([result.values[i][9] || '']);
  }

  // J = Account Manager
  sheet.getRange(1, 10).setValue('Account Manager').setFontWeight('bold');
  if (maxRows > 1) sheet.getRange(2, 10, maxRows - 1, 1).clearContent();

  // K = original Team
  sheet.getRange(1, 11).setValue('Team').setFontWeight('bold');
  if (maxRows > 1) sheet.getRange(2, 11, maxRows - 1, 1).clearContent();

  // L = normalized Team Group
  sheet.getRange(1, 12).setValue('Team Group').setFontWeight('bold');
  if (maxRows > 1) sheet.getRange(2, 12, maxRows - 1, 1).clearContent();

  // M = Store Address ID(s)
  sheet.getRange(1, 13).setValue('store_address_id').setFontWeight('bold');
  if (maxRows > 1) sheet.getRange(2, 13, maxRows - 1, 1).clearContent();

  if (!rowCount) return;

  // Write Store Address ID(s) as VALUES, not a formula.
  // This column comes directly from the BigQuery Partners source and will
  // therefore be refreshed together with Partners every week.
  sheet.getRange(2, 13, rowCount, 1).setValues(storeAddressIds);

  var amFormula = '=ARRAYFORMULA(IF(A2:A="","",IF(A2:A="Domino\'s Pizza","sebastian.banaszak@glovoapp.com",XLOOKUP(A2:A,IMPORTRANGE("' + DATA_PULL_PARTNER_AM_SOURCE_URL + '","\'PL (adjusted to SMB)\'!D:D"),IMPORTRANGE("' + DATA_PULL_PARTNER_AM_SOURCE_URL + '","\'PL (adjusted to SMB)\'!B:B"),""))))';
  sheet.getRange(2, 10).setFormula(amFormula);

  // Match AM email in Partners!J against Teams Exctract!A and return Team from B.
  // This is intentionally a direct IMPORTRANGE, so we do not depend on the old
  // Promo Log's Teams Import tab.
  var teamFormula = '=ARRAYFORMULA(IF(A2:A="","",IF(REGEXMATCH(A2:A,"^(McDonald\'s|Starbucks)$"),"Big Chain",XLOOKUP(LOWER(TRIM(J2:J)),IMPORTRANGE("https://docs.google.com/spreadsheets/d/1juKaUhWK-UggE5khGMDPeFulcDXWV3pNhpPWMQ3CrcY/edit?gid=1480006787#gid=1480006787","Teams Exctract!A:A"),IMPORTRANGE("https://docs.google.com/spreadsheets/d/1juKaUhWK-UggE5khGMDPeFulcDXWV3pNhpPWMQ3CrcY/edit?gid=1480006787#gid=1480006787","Teams Exctract!B:B"),""))))';
  sheet.getRange(2, 11).setFormula(teamFormula);

  // Normalize the original Team into the 3 reporting groups.
  var groupFormula = '=ARRAYFORMULA(IF(K2:K="","",IF(REGEXMATCH(LOWER(K2:K),"^(big chain)$"),"Big Chain",IF(REGEXMATCH(LOWER(K2:K),"^(north)$"),"North",IF(REGEXMATCH(LOWER(K2:K),"^(south)$"),"South",IF(REGEXMATCH(LOWER(K2:K),"^(east)$"),"East",IF(REGEXMATCH(LOWER(K2:K),"^(smb|groceries|retail|specialities)$"),"SMB",K2:K)))))))';
  sheet.getRange(2, 12).setFormula(groupFormula);

  sheet.getRange(1, 10, Math.max(2, rowCount + 1), 4).setNumberFormat('@');
  sheet.autoResizeColumn(10);
  sheet.autoResizeColumn(11);
  sheet.autoResizeColumn(12);
  sheet.autoResizeColumn(13);
}


function dataPullWriteTable_(sheetName, result) {
  if (!result || !result.headers || !result.headers.length) {
    throw new Error(sheetName + ': query returned no schema. Existing sheet was NOT changed.');
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);

  // Only replace the sheet AFTER BigQuery successfully completed.
  sheet.clearContents();
  sheet.clearFormats();

  sheet.getRange(1, 1, 1, result.headers.length).setValues([result.headers]);
  if (result.values.length) {
    sheet.getRange(2, 1, result.values.length, result.headers.length).setValues(result.values);
  }

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, result.headers.length).setFontWeight('bold');
  sheet.autoResizeColumns(1, result.headers.length);
  if (sheetName === DATA_PULL_PARTNERS_SHEET) { sheet.autoResizeColumn(10); sheet.autoResizeColumn(11); sheet.autoResizeColumn(12); sheet.autoResizeColumn(13); }

  return sheet;
}

function dataPullLog_(dataset, status, rowCount, message, jobId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(DATA_PULL_STATUS_SHEET);
  if (!sheet) sheet = ss.insertSheet(DATA_PULL_STATUS_SHEET);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1,1,1,6).setValues([['Dataset','Status','Rows','Last Run','Message','Job ID']]);
    sheet.getRange(1,1,1,6).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  var now = new Date();
  var data = sheet.getDataRange().getValues();
  var foundRow = 0;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === dataset) { foundRow = i + 1; break; }
  }
  if (!foundRow) foundRow = sheet.getLastRow() + 1;

  sheet.getRange(foundRow,1,1,6).setValues([[dataset,status,rowCount || 0,now,message || '',jobId || '']]);
  sheet.getRange(foundRow,4).setNumberFormat('yyyy-mm-dd hh:mm:ss');
}

function refreshPartners() {
  var label = 'Partners';
  try {
    var result = dataPullRunBigQuery_(DATA_PULL_PARTNERS_QUERY, label);
    var partnersSheet = dataPullWriteTable_(DATA_PULL_PARTNERS_SHEET, result);
    dataPullAddPartnerAMFormula_(partnersSheet, result);
    dataPullLog_(label, 'SUCCESS', result.values.length, 'Partners refreshed successfully. Account Manager is linked with XLOOKUP from the daily refreshed PL (adjusted to SMB) sheet.', result.jobId);
    CacheService.getScriptCache().remove('PROMO_LOG_PARTNERS_MASTER_SHEET');
    Logger.log('Partners refreshed: ' + result.values.length + ' rows. Job: ' + result.jobId);
    return {status:'SUCCESS', rows:result.values.length, jobId:result.jobId};
  } catch (err) {
    dataPullLog_(label, 'ERROR', 0, String(err && err.message ? err.message : err));
    throw err;
  }
}

function refreshMatrix() {
  var label = 'Matrix';
  try {
    var result = dataPullRunBigQuery_(DATA_PULL_MATRIX_QUERY, label);
    dataPullWriteTable_(DATA_PULL_MATRIX_SHEET, result);
    dataPullLog_(label, 'SUCCESS', result.values.length, 'Matrix refreshed successfully.', result.jobId);
    CacheService.getScriptCache().remove('PROMO_LOG_MATRIX_MASTER_SHEET');
    Logger.log('Matrix refreshed: ' + result.values.length + ' rows. Job: ' + result.jobId);
    return {status:'SUCCESS', rows:result.values.length, jobId:result.jobId};
  } catch (err) {
    dataPullLog_(label, 'ERROR', 0, String(err && err.message ? err.message : err));
    throw err;
  }
}

function refreshAllReferenceData() {
  var partners = refreshPartners();
  var matrix = refreshMatrix();
  return {partners: partners, matrix: matrix};
}

function setupDataPullTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    var fn = trigger.getHandlerFunction();
    if (fn === 'refreshPartners' || fn === 'refreshMatrix') ScriptApp.deleteTrigger(trigger);
  });

  // Partners: every Monday around 05:00 (script timezone).
  ScriptApp.newTrigger('refreshPartners')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(5)
    .create();

  // Matrix: first day of every month around 05:00 (script timezone).
  ScriptApp.newTrigger('refreshMatrix')
    .timeBased()
    .onMonthDay(1)
    .atHour(5)
    .create();

  Logger.log('Data Pull triggers created: Partners weekly + Matrix monthly.');
}

function dataPullStatus() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(DATA_PULL_STATUS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2,1,sheet.getLastRow()-1,6).getValues();
}

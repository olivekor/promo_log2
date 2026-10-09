# Promo tracker — optimized rebuild of the pandas pipeline.
# Same grains, same dedupe, same rounding (BQ half-up), same NULL semantics,
# same row order, same n_events>1 filter. Numbers match the original to
# floating-point noise (~1e-12 rel); see compare_outputs() at the bottom.
#
# What changed vs the day-explosion version:
#   1. Daily table is indexed ONCE (sorted by store_address_id x day, per-store
#      running cumsum). Every "sum metric X over [start, end] for this store"
#      becomes 2 searchsorted lookups + 1 subtraction instead of exploding days
#      into a DataFrame and inner-joining ~6M rows. Six explode->merge->groupby
#      passes collapse into vectorised O(#episodes) array math.
#   2. Episode grain is deduplicated up-front into (store_address_id, start, end)
#      with a multiplicity factor, so join fan-out from the SQL grain is
#      reproduced arithmetically instead of by materialising duplicate rows.
#   3. Month weights come from month arithmetic (datetime64[M]) instead of
#      exploding calendar days and calling strftime on every one.
#   4. Everything joins on int64 codes (store_address_id, partner_name,
#      year_month, event_id) instead of strings/timestamps.
#   5. Costs: the day-level pass runs once on the deduped (address, day) set and
#      the per-event block reuses it instead of exploding a second time.
#   6. Dead work removed (daily_promo copy, store_id casting, unused columns).
#
# HIT DEALS: excluded twice —
#   * Q_EPISODES: HIT promotions never create an episode (NOT LIKE 'HIT%').
#   * Q_DAILY: the daily store-level cost / co-funding / promo_orders from the
#     tracker are scaled down by the HIT share of that store-day (computed from
#     pricing_discounts), so a non-HIT episode covering a day no longer drags
#     in the HIT discounts of that day. GMV of HIT-only orders is moved into
#     DH_GMV_non_promoted_orders so it no longer counts as incremental GMV.
#
# INCREMENTAL orders/GMV are summed over the same deduped store-days as the
# cost (not prorated from episodes), so monthly ROI = incremental_gmv / cost
# compares the same days. uplift_orders/uplift_gmv stay episode-prorated.
#
# OUTPUT: pushed straight to a Google Sheet (see SHEET_ID in __main__).
# Requires: pip install google-api-python-client
# ADC must carry the spreadsheets scope:
#   gcloud auth application-default login \
#     --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/spreadsheets
from google.auth import default as google_auth_default
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
import json
import os
import tempfile

# Automatically handle GitHub Actions secret authentication (works for both Service Accounts & Authorized User keys)
if "GCP_SA_KEY" in os.environ:
    key_content = os.environ["GCP_SA_KEY"]
    # Write the secret JSON content to a temporary credentials file
    temp_creds_file = os.path.join(tempfile.gettempdir(), "gcp_credentials.json")
    with open(temp_creds_file, "w") as f:
        f.write(key_content)
    # Point Google Auth libraries to this file
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = temp_creds_file

SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/spreadsheets'
]

import math
import random
import socket
import time

import numpy as np
import pandas as pd

# ==========================================================================
# KEY EVENTS  (== key_events CTE)
# ==========================================================================
KE_DATA = [
    ('McD_Jan',      '2026-01', '2026-01-05', '2026-01-18'),
    ('FLP_Feb',      '2026-02', '2026-02-09', '2026-02-22'),
    ('Prime_W11',    '2026-03', '2026-03-09', '2026-03-15'),
    ('BPE_Mar',      '2026-03', '2026-03-16', '2026-03-29'),
    ('BPE_Apr',      '2026-04', '2026-04-13', '2026-04-26'),
    ('Warm_up_May',  '2026-05', '2026-05-04', '2026-05-17'),
    ('Prime_W21',    '2026-05', '2026-05-18', '2026-05-24'),
    ('BPE_Jun',      '2026-06', '2026-06-15', '2026-06-28'),
    ('Prime_W30_31', '2026-07', '2026-07-20', '2026-08-02'),
    ('Prime_W37',    '2026-09', '2026-09-07', '2026-09-20'),
    ('BPE_Oct',      '2026-10', '2026-10-12', '2026-10-25'),
    ('McD_Nov',      '2026-11', '2026-11-09', '2026-11-22'),
    ('BPE_Dec',      '2026-12', '2026-11-23', '2026-12-13'),
]

# store_metadata: QUALIFY instead of an outer WHERE rn=1 wrapper, and the CASE
# is evaluated AFTER dedupe instead of once per historical snapshot row.
# Identical output, far less work in BQ.
STORE_METADATA_SQL = """
store_metadata AS (
    SELECT
        store_id,
        CASE
            WHEN store_name LIKE '%BAFRA%' OR store_name LIKE '%Bafra%' THEN 'BAFRA Kebabs'
            WHEN store_name IN ("McDonald's", 'McDonalds')              THEN "McDonald's"
            WHEN store_name = 'KFC'                                     THEN 'KFC'
            WHEN store_name IN ('Zahir Kebab', 'Zahid Kebab', 'Noor Kebab', 'Ryżowa Buła', 'Rollo Pizza Express') THEN 'Zahir Kebab'
            WHEN store_name IN ('Pizza Hut', 'Zapiekarony od Pizza Hut') THEN 'Pizza Hut'
            WHEN store_name LIKE 'Domino%Pizza%'                        THEN "Domino's Pizza"
            WHEN store_name IN ('Kebab King', 'BOX KEBAB', 'Zana Restaurant & Lounge Bar', 'Kebab King Premium') THEN 'Kebab King'
            WHEN store_name IN ('MAX Premium Burgers', 'Zielone Menu z MAX') THEN 'MAX Premium Burgers'
            WHEN store_name IN ('Pasibus', 'Pasibus Galeria Arkadia')   THEN 'Pasibus'
            WHEN store_name = 'Starbucks'                               THEN 'Starbucks'
            WHEN store_name IN ('Subway by AMIC Energy', 'Pizza Sbarro by AMIC Energy') THEN 'Subway by AMIC Energy'
            WHEN store_name IN ('Berlin Döner Kebap', 'Berlin Doner')   THEN 'Berlin Döner Kebap'
            WHEN store_name IN ('Thai Wok', 'Tuk Tuk', 'Tajska Micha by Thai Wok', 'Ramen & Udon by Thai Wok') THEN 'Thai Wok'
            WHEN store_name IN ('T-Pizza (wcześniej Telepizza)', 'T-Pizza', 'Telepizza') THEN 'T-Pizza (wcześniej Telepizza)'
            WHEN store_name IN ('Sphinx', 'Chłopskie Jadło', 'The Burgers') THEN 'Sphinx'
            WHEN store_name IN ('Salad Story', 'WrapMe!')               THEN 'Salad Story'
            WHEN store_name IN ('North Fish', 'John Burg')              THEN 'North Fish'
            WHEN store_name IN ('Holy Taco', 'Mniamciu', 'Sznyclove', 'Przysmaki Alushy', 'Prokuratura', 'Grube Pierogi', 'Vito Calzone', 'Rano Podano', 'Wege Gang', 'Just Burgers') THEN 'Rebel Tang'
            WHEN store_name = 'Green Caffè Nero'                        THEN 'Green Caffè Nero'
            WHEN store_name = 'Papa Johns Pizza'                        THEN 'Papa Johns Pizza'
            WHEN store_name IN ('Costa Coffee', 'SO! COFFEE')           THEN 'Costa Coffee'
            WHEN store_name = 'Bobby Burger'                            THEN 'Bobby Burger'
            WHEN LOWER(store_name) LIKE 'am am kebab%'                  THEN 'AM AM Kebab'
            WHEN store_name LIKE 'Pizzeria 105%'                        THEN 'Pizzeria 105'
            WHEN store_name LIKE '%Osama%'                              THEN 'Osama Sushi'
            WHEN LOWER(store_name) LIKE LOWER('KOKU%SUSHI%')            THEN 'Koku Sushi'
            WHEN LOWER(store_name) LIKE '%berlin%d%ner%'                THEN 'Berlin Döner Kebap'
            WHEN LOWER(store_name) LIKE LOWER('Subway%')                THEN 'Subway'
            WHEN LOWER(store_name) LIKE LOWER('KEBAB%SUPER%KING')       THEN 'Kebab Super King'
            WHEN store_name LIKE '%Solleim%'                            THEN 'Solleim'
            ELSE TRIM(store_name)
        END AS clean_partner_name
    FROM (
        SELECT
            CAST(store_id AS STRING) AS store_id,
            store_name
        FROM `fulfillment-dwh-production.curated_data_shared_glovo.partner__stores`
        WHERE p_snapshot_date <= DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
        QUALIFY ROW_NUMBER() OVER (
            PARTITION BY CAST(store_id AS STRING)
            ORDER BY p_snapshot_date DESC
        ) = 1
    )
)
"""

PROMO_STORE_MAP_SQL = """
promo_store_map AS (
    SELECT DISTINCT
        pp.partner_promotion_id,
        CAST(od.store_address_id AS STRING) AS store_address_id,
        CAST(od.store_id AS STRING)         AS store_id
    FROM `fulfillment-dwh-production.curated_data_shared_glovo.discounts__discounts_partner_promotions` AS pp
    INNER JOIN `fulfillment-dwh-production.curated_data_shared_glovo.pricing_discounts__pricing_discounts` AS pd
        ON pd.partner_promotion_id = pp.partner_promotion_id
    INNER JOIN `fulfillment-dwh-production.curated_data_shared_glovo.order_descriptors__order_descriptors_v3` AS od
        ON CAST(od.order_id AS STRING) = CAST(pd.order_id AS STRING)
       AND od.p_creation_date >= '2026-01-01'
       AND od.p_creation_date < CURRENT_DATE()
    WHERE DATE(pp.partner_promotion_started_at) >= '2026-01-01'
      AND DATE(pp.partner_promotion_started_at) < CURRENT_DATE()
      AND (pp.segment_id <> 36692 OR pp.segment_id IS NULL)
)
"""

Q_DAILY = f"""
WITH {STORE_METADATA_SQL.strip()},
-- per zamówienie: rabaty promotool ogółem vs HIT
promo_orders_pd AS (
    SELECT
        CAST(pd.order_id AS STRING) AS order_id,
        SUM(COALESCE(CAST(pd.total_discounts_eur AS FLOAT64), 0)) AS all_cost,
        SUM(IF(COALESCE(pd.partner_promotion_name, '') LIKE 'HIT%',
               COALESCE(CAST(pd.total_discounts_eur AS FLOAT64), 0), 0)) AS hit_cost,
        SUM(COALESCE(pd.product_discount_assumed_by_glovo_eur, 0)
          + COALESCE(pd.delivery_discount_assumed_by_glovo_eur, 0)) AS all_cofund,
        SUM(IF(COALESCE(pd.partner_promotion_name, '') LIKE 'HIT%',
               COALESCE(pd.product_discount_assumed_by_glovo_eur, 0)
             + COALESCE(pd.delivery_discount_assumed_by_glovo_eur, 0), 0)) AS hit_cofund,
        LOGICAL_AND(COALESCE(pd.partner_promotion_name, '') LIKE 'HIT%') AS all_hit
    FROM `fulfillment-dwh-production.curated_data_shared_glovo.pricing_discounts__pricing_discounts` pd
    WHERE pd.p_creation_date >= '2025-10-31'
      AND pd.partner_promotion_id IS NOT NULL
    GROUP BY 1
),
-- wszystkie zamówienia PL per sklep x dzień (mianownik dla udziału HIT w GMV)
pl_orders AS (
    SELECT
        CAST(od.order_id AS STRING)         AS order_id,
        CAST(od.store_address_id AS STRING) AS store_address_id,
        od.p_creation_date,
        COALESCE(od.order_total_purchase_eur, 0) AS gmv
    FROM `fulfillment-dwh-production.curated_data_shared_glovo.order_descriptors__order_descriptors_v3` od
    WHERE od.p_creation_date >= '2025-11-01'
      AND od.order_country_code = 'PL'
),
-- per sklep x dzień: udział HIT w koszcie / co-fundingu / zamówieniach promo / GMV
hit_share AS (
    SELECT
        po.store_address_id,
        po.p_creation_date,
        SAFE_DIVIDE(SUM(o.hit_cost),   SUM(o.all_cost))   AS hit_cost_share,
        SAFE_DIVIDE(SUM(o.hit_cofund), SUM(o.all_cofund)) AS hit_cofund_share,
        SAFE_DIVIDE(COUNTIF(o.all_hit), COUNT(o.order_id)) AS hit_orders_share,
        -- GMV zamówień z WYŁĄCZNIE rabatami HIT jako udział w całym GMV sklepu
        SAFE_DIVIDE(SUM(IF(o.all_hit, po.gmv, 0)), SUM(po.gmv)) AS hit_gmv_share
    FROM pl_orders po
    LEFT JOIN promo_orders_pd o
      ON o.order_id = po.order_id
    GROUP BY 1, 2
    HAVING SUM(o.hit_cost) > 0 OR COUNTIF(o.all_hit) > 0
)
SELECT
    CAST(dp.store_address_id AS STRING) AS store_address_id,
    dp.p_creation_date,
    dp.total_orders,
    dp.DH_GMV,
    dp.total_promotool_discounts_glovo_funded * (1 - COALESCE(h.hit_cofund_share, 0))
        AS total_promotool_discounts_glovo_funded,
    dp.total_promotool_discounts * (1 - COALESCE(h.hit_cost_share, 0))
        AS total_promotool_discounts,
    dp.promo_orders * (1 - COALESCE(h.hit_orders_share, 0)) AS promo_orders,
    -- GMV zamówień tylko-HIT przesunięte z "promoted" do "non-promoted",
    -- żeby nie wchodziło do incremental_gmv (= DH_GMV - non_promoted)
    LEAST(
        COALESCE(dp.DH_GMV_non_promoted_orders, 0)
          + COALESCE(dp.DH_GMV, 0) * COALESCE(h.hit_gmv_share, 0),
        GREATEST(COALESCE(dp.DH_GMV, 0), COALESCE(dp.DH_GMV_non_promoted_orders, 0))
    ) AS DH_GMV_non_promoted_orders,
    sm.clean_partner_name
FROM `fulfillment-dwh-production.curated_data_shared_glovo.promos_okr__promos_okr_tracker_v2` dp
LEFT JOIN store_metadata sm
    ON CAST(dp.store_id AS STRING) = sm.store_id
LEFT JOIN hit_share h
    ON h.store_address_id = CAST(dp.store_address_id AS STRING)
   AND h.p_creation_date = dp.p_creation_date
WHERE dp.country_code = 'PL'
  AND dp.p_creation_date >= '2025-11-01'
  AND (dp.segmentation <> 'Q-Commerce' OR dp.segmentation IS NULL)
"""

Q_EPISODES = f"""
WITH {PROMO_STORE_MAP_SQL.strip()},
promo_base AS (
    SELECT
        pp.partner_promotion_id,
        DATE(pp.partner_promotion_started_at)  AS partner_promotion_started_at,
        DATE(pp.partner_promotion_ended_at)    AS partner_promotion_ended_at,
        LEAST(DATE(pp.partner_promotion_ended_at), CURRENT_DATE() - 1) AS effective_end_date,
        psm.store_address_id,
        pp.partner_promotion_name = 'TOP3 2026' AS is_top3,
        (pp.partner_promotion_name LIKE '%SME_Unhealthy_Food%'
         OR pp.partner_promotion_name LIKE '%SME_Healthy_Food%') AS is_sme
    FROM `fulfillment-dwh-production.curated_data_shared_glovo.discounts__discounts_partner_promotions` AS pp
    INNER JOIN promo_store_map psm
        ON psm.partner_promotion_id = pp.partner_promotion_id
    WHERE DATE(pp.partner_promotion_started_at) >= '2026-01-01'
      AND DATE(pp.partner_promotion_started_at) < CURRENT_DATE()
      AND (pp.segment_id <> 36692 OR pp.segment_id IS NULL)
      AND pp.partner_promotion_name NOT LIKE 'HIT%'  -- wykluczenie HIT Deals
)
SELECT
    store_address_id,
    partner_promotion_started_at  AS episode_start,
    CAST(partner_promotion_ended_at AS STRING) AS episode_end_raw,  -- sentinel dates (3999-12-31) overflow pandas datetime64
    effective_end_date            AS episode_end,
    DATE_DIFF(effective_end_date, partner_promotion_started_at, DAY) + 1 AS episode_length_days,
    MAX(CAST(is_top3 AS INT64)) = 1 AS is_top3_episode,
    MAX(CAST(is_sme AS INT64))  = 1 AS is_sme_episode,
    DATE_SUB(partner_promotion_started_at,
             INTERVAL DATE_DIFF(effective_end_date, partner_promotion_started_at, DAY) + 1 DAY) AS baseline_start,
    DATE_SUB(partner_promotion_started_at, INTERVAL 1 DAY) AS baseline_end
FROM promo_base
GROUP BY store_address_id, partner_promotion_started_at, partner_promotion_ended_at, effective_end_date
"""

Q_ADDR_MAP = f"""
WITH {PROMO_STORE_MAP_SQL.strip()},
{STORE_METADATA_SQL.strip()}
SELECT DISTINCT
    psm.store_address_id,
    sm.clean_partner_name
FROM (SELECT DISTINCT store_address_id, store_id FROM promo_store_map) psm
LEFT JOIN store_metadata sm ON psm.store_id = sm.store_id
"""

# ==========================================================================
# CONSTANTS / SMALL HELPERS
# ==========================================================================
NUM_COLS = [
    'total_orders', 'DH_GMV', 'total_promotool_discounts_glovo_funded',
    'total_promotool_discounts', 'promo_orders', 'DH_GMV_non_promoted_orders',
]
I_ORD, I_GMV, I_COF, I_COST, I_PORD, I_NPGMV = range(6)
METRIC_COLS = ['uplift_orders', 'uplift_gmv', 'incremental_orders', 'incremental_gmv']
EPISODE_COLS = ['uplift_orders_episode', 'uplift_gmv_episode',
                'incremental_orders_episode', 'incremental_gmv_episode']


def round_half_up(x, decimals=2):
    """BigQuery-style ROUND (half away from zero). np.round is banker's — don't use it."""
    x = np.asarray(x, dtype=float)
    factor = 10.0 ** decimals
    return np.sign(x) * np.floor(np.abs(x) * factor + 0.5) / factor


def to_day(x):
    """datetime-ish -> int64 days since 1970-01-01."""
    return np.asarray(pd.to_datetime(x).to_numpy(), dtype='datetime64[D]').astype(np.int64)


def _ranges(counts):
    """[3,0,2] -> [0,1,2,0,1]. Vectorised; replaces the per-row arange loop."""
    counts = np.asarray(counts, dtype=np.int64)
    counts = counts[counts > 0]
    total = int(counts.sum())
    if total == 0:
        return np.zeros(0, dtype=np.int64)
    out = np.ones(total, dtype=np.int64)
    out[0] = 0
    if len(counts) > 1:
        out[np.cumsum(counts)[:-1]] = 1 - counts[:-1]
    return np.cumsum(out)


def explode_span(start, end):
    """One row per calendar day in [start, end]. Returns (row_idx, day)."""
    start = np.asarray(start, np.int64)
    end = np.asarray(end, np.int64)
    n = np.maximum(end - start + 1, 0)
    rows = np.repeat(np.arange(len(start)), n)
    return rows, start[rows] + _ranges(n)


def month_split(start, end):
    """Days-per-calendar-month for each [start, end] span, without touching days.
    Returns (row_idx, month_index_since_1970, days_in_month)."""
    start = np.asarray(start, np.int64)
    end = np.asarray(end, np.int64)
    ms = start.astype('datetime64[D]').astype('datetime64[M]').astype(np.int64)
    me = end.astype('datetime64[D]').astype('datetime64[M]').astype(np.int64)
    n = np.where(end >= start, me - ms + 1, 0)
    rows = np.repeat(np.arange(len(start)), n)
    m = ms[rows] + _ranges(n)
    m_first = m.astype('datetime64[M]').astype('datetime64[D]').astype(np.int64)
    m_last = (m + 1).astype('datetime64[M]').astype('datetime64[D]').astype(np.int64) - 1
    s = np.maximum(start[rows], m_first)
    e = np.minimum(end[rows], m_last)
    return rows, m, (e - s + 1)


def month_to_ym(m):
    """month index since 1970 -> 202601-style int (sorts like 'YYYY-MM')."""
    m = np.asarray(m, np.int64)
    return (1970 + m // 12) * 100 + (m % 12 + 1)


def ym_to_str(ym):
    ym = np.asarray(ym, np.int64)
    return np.array([f"{v // 100:04d}-{v % 100:02d}" for v in ym], dtype=object)


# Day-level columns summed over the cost day set. Incremental metrics are
# computed from the SAME store-days as the cost, so ROI compares like with like.
DAY_IDX = [I_COF, I_COST, I_PORD, I_GMV, I_NPGMV]


def _day_metrics(v):
    """(n, len(DAY_IDX)) day sums -> cost + incremental columns."""
    return {
        'co_funding':         v[:, 0],
        'total_promo_cost':   v[:, 1],
        'incremental_orders': round_half_up(v[:, 2] * 0.4, 2),
        'incremental_gmv':    round_half_up((v[:, 3] - v[:, 4]) * 0.4, 2),
    }


def _group_sum(keys, values, sort_order=None):
    """Grouped sum on an int64 key. Returns (unique_keys_sorted, sums)."""
    n = len(keys)
    if n == 0:
        return np.zeros(0, np.int64), np.zeros((0, values.shape[1]))
    if sort_order is None:
        sort_order = np.argsort(keys, kind='stable')
    ks = keys[sort_order]
    starts = np.flatnonzero(np.concatenate(([True], ks[1:] != ks[:-1])))
    return ks[starts], np.add.reduceat(values[sort_order], starts, axis=0)


# ==========================================================================
# DAILY RANGE INDEX
# Sorted (store_address_id x day) view of the daily table with a per-store
# running cumsum. sums(addr, start, end) == the explode->merge->groupby the
# original did, in O(log n) per query.
# ==========================================================================
class DailyRanges:
    def __init__(self, daily, addr_index, partner_index):
        code = addr_index.get_indexer(daily['store_address_id'])
        day = to_day(daily['p_creation_date'])
        order = np.lexsort((day, code))          # stable: preserves intra-day row order
        self.code = code[order]
        self.day = day[order]
        self.vals = daily[NUM_COLS].to_numpy(dtype=float)[order]
        self.partner = partner_index.get_indexer(daily['clean_partner_name'])[order]
        self.ym = month_to_ym(
            self.day.astype('datetime64[D]').astype('datetime64[M]').astype(np.int64)
        )
        self.N = len(self.code)
        self.min_day = int(self.day.min()) if self.N else 0
        self.max_day = int(self.day.max()) if self.N else 0
        self.K = (self.max_day - self.min_day) + 3   # day 0 and K-1 are sentinels
        self.key = self.code.astype(np.int64) * self.K + (self.day - self.min_day + 1)
        if self.N:
            # per-store cumsum: magnitudes stay at store scale, so range diffs
            # don't lose precision the way a global cumsum would
            self.C = pd.DataFrame(self.vals).groupby(self.code, sort=False).cumsum().to_numpy()
            newblk = np.concatenate(([True], self.code[1:] != self.code[:-1]))
            self.blk_start = np.flatnonzero(newblk)[np.cumsum(newblk) - 1]
        else:
            self.C = np.zeros((0, len(NUM_COLS)))
            self.blk_start = np.zeros(0, np.int64)

    def bounds(self, addr, start, end):
        addr = np.asarray(addr, np.int64)
        s = np.clip(np.asarray(start, np.int64) - self.min_day + 1, 0, self.K - 1)
        e = np.clip(np.asarray(end, np.int64) - self.min_day + 1, 0, self.K - 1)
        base = addr * self.K
        lo = np.searchsorted(self.key, base + s, 'left')
        hi = np.searchsorted(self.key, base + e, 'right')
        return lo, hi

    def sums(self, addr, start, end):
        """-> ((q, 6) metric sums, (q,) matched daily row count)"""
        lo, hi = self.bounds(addr, start, end)
        n = np.maximum(hi - lo, 0)
        if self.N == 0 or len(lo) == 0:
            return np.zeros((len(lo), len(NUM_COLS))), n
        hi_i = np.clip(hi - 1, 0, self.N - 1)
        lo_i = lo - 1
        total = self.C[hi_i]
        has_base = (lo_i >= self.blk_start[hi_i])[:, None]
        base = np.where(has_base, self.C[np.clip(lo_i, 0, self.N - 1)], 0.0)
        return np.where((n > 0)[:, None], total - base, 0.0), n

    def counts(self, addr, start, end):
        lo, hi = self.bounds(addr, start, end)
        return np.maximum(hi - lo, 0)

    def gather(self, addr, day):
        """Daily row positions matching (addr, day) exactly. -> (row_idx, pos)."""
        lo, hi = self.bounds(addr, day, day)
        cnt = np.maximum(hi - lo, 0)
        rows = np.repeat(np.arange(len(lo)), cnt)
        return rows, np.repeat(lo, cnt) + _ranges(cnt)


# ==========================================================================
# EXTRACTION
# ==========================================================================
def extract_data_from_bq(project_id):
    from google.cloud import bigquery
    client = bigquery.Client(project=project_id)

    def q(sql, label):
        print(f"Pulling {label}...")
        try:
            df = client.query(sql).to_dataframe(create_bqstorage_client=True,
                                                progress_bar_type=None)
        except TypeError:
            df = client.query(sql).to_dataframe()
        print(f"  rows: {len(df)}")
        return df

    daily = q(Q_DAILY, "daily performance")
    episodes = q(Q_EPISODES, "episode definitions")
    addr_map = q(Q_ADDR_MAP, "store_address -> partner map")
    return daily, episodes, addr_map


# ==========================================================================
# CALCULATION ENGINE
# ==========================================================================
def _episode_metrics(promo, base, mult):
    """== the CASE WHEN ... THEN metric ELSE 0 END sums, already grouped."""
    mult = mult.astype(float)
    return {
        'promo_orders_sum':      promo[:, I_ORD] * mult,
        'baseline_orders_sum':   base[:, I_ORD] * mult,
        'promo_gmv_sum':         promo[:, I_GMV] * mult,
        'baseline_gmv_sum':      base[:, I_GMV] * mult,
        'incr_promo_orders_sum': promo[:, I_PORD] * mult,
        'incr_promo_gmv_sum':    (promo[:, I_GMV] - promo[:, I_NPGMV]) * mult,
    }


def _add_uplift_calc(t):
    """== *_calc CTEs: uplift diffs + ROUND(incr * 0.4, 2) at episode level."""
    t['uplift_orders_episode'] = t['promo_orders_sum'] - t['baseline_orders_sum']
    t['uplift_gmv_episode'] = t['promo_gmv_sum'] - t['baseline_gmv_sum']
    t['incremental_orders_episode'] = round_half_up(t['incr_promo_orders_sum'] * 0.4, 2)
    t['incremental_gmv_episode'] = round_half_up(t['incr_promo_gmv_sum'] * 0.4, 2)
    return t


def _prorate(weights, totals, id_col, length_col, promo_type):
    """== uplift_*_by_month CTEs: metric * SAFE_DIVIDE(days_in_month, length)."""
    m = weights.merge(totals, on=id_col, how='inner')
    ratio = np.where(m[length_col] > 0, m['days_in_month'] / m[length_col], np.nan)
    out = pd.DataFrame({'addr': m['addr'].to_numpy(), 'ym': m['ym'].to_numpy()})
    for tgt, src in zip(METRIC_COLS, EPISODE_COLS):
        out[tgt] = m[src].to_numpy() * ratio
    out['promo_type'] = promo_type
    return out


def run_promo_calculations(daily, episodes, addr_map):
    # ---- type hygiene ---------------------------------------------------
    daily = daily.copy()
    for c in NUM_COLS:
        daily[c] = pd.to_numeric(daily[c], errors='coerce').fillna(0.0).astype(float)
    daily['p_creation_date'] = pd.to_datetime(daily['p_creation_date'])
    daily['store_address_id'] = daily['store_address_id'].astype(str)

    episodes = episodes.copy()
    for c in ('episode_start', 'episode_end', 'baseline_start', 'baseline_end'):
        episodes[c] = pd.to_datetime(episodes[c])
    episodes['store_address_id'] = episodes['store_address_id'].astype(str)
    ep_len_all = pd.to_numeric(episodes['episode_length_days']).astype('int64').to_numpy()
    is_top3 = episodes['is_top3_episode'].fillna(False).to_numpy(bool)
    is_sme = episodes['is_sme_episode'].fillna(False).to_numpy(bool)

    addr_map = addr_map.copy()
    addr_map['store_address_id'] = addr_map['store_address_id'].astype(str)

    # ---- code spaces (all joins below are int64) -------------------------
    addr_index = pd.Index(pd.unique(np.concatenate([
        daily['store_address_id'].to_numpy(),
        episodes['store_address_id'].to_numpy(),
        addr_map['store_address_id'].to_numpy(),
    ])))
    partner_index = pd.Index(pd.unique(np.concatenate([
        daily['clean_partner_name'].dropna().unique(),
        addr_map['clean_partner_name'].dropna().unique(),
    ]))).sort_values()          # sorted => groupby on codes orders like the names

    dr = DailyRanges(daily, addr_index, partner_index)

    # ---- key events ------------------------------------------------------
    kev = pd.DataFrame(KE_DATA, columns=['event_id', 'ke_year_month', 'event_start', 'event_end'])
    ev_s, ev_e = to_day(kev['event_start']), to_day(kev['event_end'])
    _o = np.argsort(ev_s)
    assert np.all(ev_e[_o][:-1] < ev_s[_o][1:]), "key events overlap — day->event map is ambiguous"
    ev_rank = np.argsort(np.argsort(kev['event_id'].to_numpy()))   # lexicographic order
    ev_ym = np.array([int(s.replace('-', '')) for s in kev['ke_year_month']], dtype=np.int64)
    _rows, ke_days = explode_span(ev_s, ev_e)
    _srt = np.argsort(ke_days)
    ke_days, ke_day_ev = ke_days[_srt], _rows[_srt]

    def ke_lookup(days):
        """(is_key_event_day, event_row_idx) for an array of day ints."""
        i = np.searchsorted(ke_days, days)
        i_c = np.clip(i, 0, max(len(ke_days) - 1, 0))
        hit = (i < len(ke_days)) & (ke_days[i_c] == days) if len(ke_days) else np.zeros(len(days), bool)
        return hit, np.where(hit, ke_day_ev[i_c], -1)

    # =====================================================================
    # EPISODE GRAIN — dedupe to (store_address_id, start, end) + multiplicity
    # (SQL grain also carries the raw end date, so the same key can repeat;
    # duplicates are reproduced arithmetically, not by materialising rows)
    # =====================================================================
    ep_addr = addr_index.get_indexer(episodes['store_address_id'])
    ep_s, ep_e = to_day(episodes['episode_start']), to_day(episodes['episode_end'])
    ep_bs, ep_be = to_day(episodes['baseline_start']), to_day(episodes['baseline_end'])
    ekey = (((ep_addr.astype(np.int64) + 1) << 42)
            | (ep_s.astype(np.int64) << 21) | ep_e.astype(np.int64))
    _uk, first, inv, mult_all = np.unique(ekey, return_index=True, return_inverse=True,
                                          return_counts=True)
    inv = inv.ravel()
    U = len(first)
    u_addr, u_s, u_e = ep_addr[first], ep_s[first], ep_e[first]
    u_bs, u_be, u_len = ep_bs[first], ep_be[first], ep_len_all[first]
    mult_ns = np.bincount(inv[~is_sme], minlength=U)
    mult_sme = np.bincount(inv[is_sme], minlength=U)
    # (key, is_top3) grain — is_top3 can differ between duplicate rows
    mult_rem = np.bincount(inv[~is_sme] * 2 + is_top3[~is_sme].astype(np.int64),
                           minlength=2 * U)

    # =====================================================================
    # EPISODE TOTALS  (== episode_totals -> episode_totals_calc)
    # =====================================================================
    promo, n_promo = dr.sums(u_addr, u_s, u_e)
    base, n_base = dr.sums(u_addr, u_bs, u_be)
    alive = (n_promo + n_base) > 0          # == "the groupby produced a row"
    ep_tot = pd.DataFrame({'key_id': np.arange(U)[alive],
                           'episode_length_days': u_len[alive]})
    for k, v in _episode_metrics(promo[alive], base[alive], mult_all[alive]).items():
        ep_tot[k] = v
    ep_tot = _add_uplift_calc(ep_tot)

    # ---- month weights (== episode_month_weights) ------------------------
    w_rows, w_m, w_days = month_split(u_s, u_e)
    ep_w = pd.DataFrame({'key_id': w_rows, 'ym': month_to_ym(w_m), 'days': w_days,
                         'addr': u_addr[w_rows]})

    def branch_weights(mult):
        w = ep_w.copy()
        w['days_in_month'] = w['days'] * mult[w['key_id'].to_numpy()]
        return w[w['days_in_month'] > 0]

    uplift_total = _prorate(branch_weights(mult_ns), ep_tot, 'key_id',
                            'episode_length_days', 'Total')
    uplift_sme = _prorate(branch_weights(mult_sme), ep_tot, 'key_id',
                          'episode_length_days', 'SME')

    # =====================================================================
    # KEY-EVENT WINDOWS  (== episode_ke_window/_baseline/_totals/_calc)
    # =====================================================================
    ns_ids = np.flatnonzero(mult_ns > 0)
    E = len(kev)
    ii = np.repeat(ns_ids, E)
    jj = np.tile(np.arange(E), len(ns_ids))
    ov = (u_s[ii] <= ev_e[jj]) & (u_e[ii] >= ev_s[jj])
    ii, jj = ii[ov], jj[ov]
    k_s = np.maximum(u_s[ii], ev_s[jj])
    k_e = np.minimum(u_e[ii], ev_e[jj])
    k_len = k_e - k_s + 1
    k_bs, k_be = k_s - k_len, k_s - 1

    kp, n_kp = dr.sums(u_addr[ii], k_s, k_e)
    kb, n_kb = dr.sums(u_addr[ii], k_bs, k_be)
    k_alive = (n_kp + n_kb) > 0
    ke_tot = pd.DataFrame({'pair_id': np.flatnonzero(k_alive),
                           'key_id': ii[k_alive], 'ev': jj[k_alive],
                           'ke_length_days': k_len[k_alive]})
    for k, v in _episode_metrics(kp[k_alive], kb[k_alive], mult_ns[ii][k_alive]).items():
        ke_tot[k] = v
    ke_tot = _add_uplift_calc(ke_tot)

    kw_rows, kw_m, kw_days = month_split(k_s, k_e)
    ke_w = pd.DataFrame({'pair_id': kw_rows, 'ym': month_to_ym(kw_m),
                         'days_in_month': kw_days * mult_ns[ii][kw_rows],
                         'addr': u_addr[ii][kw_rows]})
    ke_w = ke_w[ke_w['days_in_month'] > 0]
    uplift_ke = _prorate(ke_w, ke_tot, 'pair_id', 'ke_length_days', 'Key Event')

    # =====================================================================
    # REMAINDER  (== episode_ke_windows_agg -> episode_remainder[_totals/_calc])
    # =====================================================================
    tkd = np.bincount(ii, weights=(k_len * mult_ns[ii]).astype(float),
                      minlength=U).astype(np.int64)
    rem_len_key = u_len - tkd
    rk_ids = np.flatnonzero(mult_rem > 0)                    # index into (key*2 + top3)
    rk_key, rk_top3 = rk_ids // 2, (rk_ids % 2).astype(bool)
    ok = rem_len_key[rk_key] > 0
    rk_ids, rk_key, rk_top3 = rk_ids[ok], rk_key[ok], rk_top3[ok]
    r_len = rem_len_key[rk_key]
    r_addr, r_s, r_e = u_addr[rk_key], u_s[rk_key], u_e[rk_key]
    r_bs, r_be = r_s - r_len, r_s - 1

    ep_promo_by_key = np.zeros((U, len(NUM_COLS)))
    ep_promo_by_key[np.arange(U)] = promo                    # promo-window sums per key
    ke_promo_by_key = np.zeros((U, len(NUM_COLS)))
    for c in range(len(NUM_COLS)):
        ke_promo_by_key[:, c] = np.bincount(ii, weights=kp[:, c], minlength=U)
    r_promo = ep_promo_by_key[rk_key] - ke_promo_by_key[rk_key]   # promo days minus KE days
    r_base, _ = dr.sums(r_addr, r_bs, r_be)
    r_alive = dr.counts(r_addr, r_bs, r_e) > 0

    rem_tot = pd.DataFrame({'rem_id': rk_ids[r_alive],
                            'remainder_length_days': r_len[r_alive],
                            'is_top3': rk_top3[r_alive]})
    for k, v in _episode_metrics(r_promo[r_alive], r_base[r_alive],
                                 mult_rem[rk_ids][r_alive]).items():
        rem_tot[k] = v
    rem_tot = _add_uplift_calc(rem_tot)

    # remainder month weights = episode month days minus KE month days
    rw = pd.DataFrame({'key_id': w_rows, 'ym': month_to_ym(w_m), 'days': w_days})
    ke_month = (pd.DataFrame({'key_id': ii[kw_rows], 'ym': month_to_ym(kw_m),
                              'ke_days': kw_days})
                .groupby(['key_id', 'ym'], as_index=False)['ke_days'].sum())
    rem_w = (pd.DataFrame({'rem_id': rk_ids, 'key_id': rk_key})
             .merge(rw, on='key_id', how='inner')
             .merge(ke_month, on=['key_id', 'ym'], how='left'))
    rem_w['ke_days'] = rem_w['ke_days'].fillna(0).astype(np.int64)
    rem_w['days_in_month'] = ((rem_w['days'] - rem_w['ke_days'])
                              * mult_rem[rem_w['rem_id'].to_numpy()])
    rem_w = rem_w[rem_w['days_in_month'] > 0].copy()
    rem_w['addr'] = u_addr[rem_w['key_id'].to_numpy()]
    uplift_rem = _prorate(rem_w, rem_tot, 'rem_id', 'remainder_length_days', 'Other')
    rem_is_top3 = rem_w.merge(rem_tot[['rem_id', 'is_top3']], on='rem_id',
                              how='inner')['is_top3'].to_numpy()
    uplift_rem['promo_type'] = np.where(rem_is_top3, 'Always On', 'Other')

    # =====================================================================
    # UPLIFT AGG  (== uplift_all + uplift_agg)
    # =====================================================================
    uplift_all = pd.concat([uplift_total, uplift_ke, uplift_rem, uplift_sme],
                           ignore_index=True)
    ap = addr_map[['store_address_id', 'clean_partner_name']].drop_duplicates()
    ap = pd.DataFrame({'addr': addr_index.get_indexer(ap['store_address_id']),
                       'p_code': partner_index.get_indexer(ap['clean_partner_name'])})
    ap = ap[ap['p_code'] >= 0]
    # only the baseline-vs-promo uplift is prorated from episodes; incremental
    # orders/GMV come from the day-level cost pass below
    UPLIFT_COLS = ['uplift_orders', 'uplift_gmv']
    uplift_agg = (uplift_all.merge(ap, on='addr', how='inner')
                  .groupby(['p_code', 'ym', 'promo_type'], as_index=False)[UPLIFT_COLS].sum())

    # =====================================================================
    # COSTS + INCREMENTAL  (== fact_episode_days -> promo_day_flags -> costs)
    # Day-level dedupe: a day counts ONCE no matter how many episodes cover it.
    # Incremental orders/GMV are summed over exactly these days too.
    # =====================================================================
    ns_top3_ids = np.flatnonzero(mult_rem > 0)               # (key, is_top3) combos
    d_rows, d_days = explode_span(u_s[ns_top3_ids // 2], u_e[ns_top3_ids // 2])
    d_addr = u_addr[ns_top3_ids // 2][d_rows]
    d_top3 = (ns_top3_ids % 2).astype(np.int8)[d_rows]
    dkey = d_addr.astype(np.int64) * 1_000_000 + d_days
    order = np.argsort(dkey, kind='stable')
    if len(dkey):
        ks = dkey[order]
        starts = np.flatnonzero(np.concatenate(([True], ks[1:] != ks[:-1])))
        uday_key = ks[starts]
        uday_ao = np.maximum.reduceat(d_top3[order], starts).astype(bool)
    else:
        uday_key, uday_ao = np.zeros(0, np.int64), np.zeros(0, bool)
    uday_addr = uday_key // 1_000_000
    uday_day = uday_key % 1_000_000
    uday_ke, uday_ev = ke_lookup(uday_day)

    g_rows, g_pos = dr.gather(uday_addr, uday_day)
    keep = dr.partner[g_pos] >= 0                            # == clean_partner_name NOT NULL
    g_rows, g_pos = g_rows[keep], g_pos[keep]
    c_key = dr.partner[g_pos].astype(np.int64) * 1_000_000 + dr.ym[g_pos]
    c_vals = dr.vals[g_pos][:, DAY_IDX]
    c_ke, c_ao = uday_ke[g_rows], uday_ao[g_rows]

    c_order = np.argsort(c_key, kind='stable')
    ck, cv, cke, cao = c_key[c_order], c_vals[c_order], c_ke[c_order], c_ao[c_order]

    def cost_slice(mask, promo_type):
        k, v = _group_sum(ck[mask], cv[mask], np.arange(int(mask.sum())))
        return pd.DataFrame({'p_code': k // 1_000_000, 'ym': k % 1_000_000,
                             'promo_type': promo_type, **_day_metrics(v)})

    all_true = np.ones(len(ck), bool)
    cost_frames = [
        cost_slice(all_true, 'Total'),
        cost_slice(cke, 'Key Event'),
        cost_slice(cao, 'Always On Total'),
        cost_slice(cao & ~cke, 'Always On'),
        cost_slice(~cke & ~cao, 'Other'),
    ]

    # SME costs (== fact_episode_days_sme branch)
    sme_ids = np.flatnonzero(mult_sme > 0)
    s_rows, s_days = explode_span(u_s[sme_ids], u_e[sme_ids])
    s_key = np.unique(u_addr[sme_ids][s_rows].astype(np.int64) * 1_000_000 + s_days)
    sg_rows, sg_pos = dr.gather(s_key // 1_000_000, s_key % 1_000_000)
    sg_pos = sg_pos[dr.partner[sg_pos] >= 0]
    s_gkey = dr.partner[sg_pos].astype(np.int64) * 1_000_000 + dr.ym[sg_pos]
    k, v = _group_sum(s_gkey, dr.vals[sg_pos][:, DAY_IDX])
    cost_frames.append(pd.DataFrame({'p_code': k // 1_000_000, 'ym': k % 1_000_000,
                                     'promo_type': 'SME', **_day_metrics(v)}))
    costs = pd.concat(cost_frames, ignore_index=True)

    # =====================================================================
    # MONTHLY GMV  (== monthly_partner_performance + monthly_total_performance)
    # NULL partner stays in the Poland denominator (SQL dropna=False semantics).
    # =====================================================================
    d26 = dr.day >= to_day(pd.Series(['2026-01-01']))[0]
    mkey = (dr.partner[d26] + 1).astype(np.int64) * 1_000_000 + dr.ym[d26]
    mk, mv = _group_sum(mkey, dr.vals[d26][:, [I_GMV]])
    monthly = pd.DataFrame({'p_code': (mk // 1_000_000) - 1, 'ym': mk % 1_000_000,
                            'total_partner_gmv_monthly': mv[:, 0]})
    poland = monthly.groupby('ym')['total_partner_gmv_monthly'].sum()
    monthly['poland'] = monthly['ym'].map(poland)

    def attach_monthly(frame):
        out = frame.merge(monthly, on=['p_code', 'ym'], how='left')
        out['total_partner_gmv_monthly'] = out['total_partner_gmv_monthly'].fillna(0.0)
        pol = out.pop('poland').fillna(0.0)
        out['partner_share_of_food_poland_gmv_pct'] = np.where(
            pol > 0, round_half_up(out['total_partner_gmv_monthly'] / pol * 100, 2), 0.0)
        return out

    # =====================================================================
    # MAIN BLOCK  (== costs LEFT JOIN uplift_agg LEFT JOIN monthly)
    # NO fillna(0) on uplifts — NULL stays NULL, exactly like SQL.
    # =====================================================================
    with np.errstate(invalid='ignore', divide='ignore'):
        main = costs.merge(uplift_agg, on=['p_code', 'ym', 'promo_type'], how='left')
        main['roi'] = np.where(main['total_promo_cost'] > 0,
                               round_half_up(main['incremental_gmv'] / main['total_promo_cost'], 2),
                               np.nan)
        main = attach_monthly(main)

        # =================================================================
        # PER-EVENT ROWS (== fact_ke_event_days, costs_ke_by_event,
        # uplift_ke_by_event, ke_by_event_final, ke_event_counts)
        # Unprorated, stamped with the event's canonical year_month, shown
        # only when a partner-month has >1 distinct event. Reuses the cost
        # day scan instead of exploding episode days a second time.
        # =================================================================
        e_mask = c_ke
        e_key = (dr.partner[g_pos][e_mask].astype(np.int64) * 100
                 + ev_rank[uday_ev[g_rows][e_mask]])
        k, v = _group_sum(e_key, dr.vals[g_pos][e_mask][:, DAY_IDX])
        ev_of_rank = np.argsort(ev_rank)
        ke_final = pd.DataFrame({'p_code': k // 100, 'ev': ev_of_rank[k % 100],
                                 **_day_metrics(v)})

        ke_ev_up = (ke_tot[['key_id', 'ev'] + EPISODE_COLS[:2]]
                    .assign(addr=lambda d: u_addr[d['key_id'].to_numpy()])
                    .merge(ap, on='addr', how='inner')
                    .groupby(['p_code', 'ev'], as_index=False)[EPISODE_COLS[:2]].sum()
                    .rename(columns=dict(zip(EPISODE_COLS[:2], UPLIFT_COLS))))
        ke_final = ke_final.merge(ke_ev_up, on=['p_code', 'ev'], how='left')
        ke_final['ym'] = ev_ym[ke_final['ev'].to_numpy()]
        ke_final['promo_type'] = kev['event_id'].to_numpy()[ke_final['ev'].to_numpy()]
        ke_final['roi'] = np.where(ke_final['total_promo_cost'] > 0,
                                   round_half_up(ke_final['incremental_gmv'] / ke_final['total_promo_cost'], 2),
                                   np.nan)
        n_ev = (ke_final.groupby(['p_code', 'ym'], as_index=False)['promo_type']
                .nunique().rename(columns={'promo_type': 'n_events'}))
        ke_final = ke_final.merge(n_ev, on=['p_code', 'ym'], how='left')
        ke_final = ke_final[ke_final['n_events'] > 1].drop(columns=['n_events', 'ev'])
        ke_final = attach_monthly(ke_final)

    # =====================================================================
    # UNION + SORT  (== final SELECT ... UNION ALL ... ORDER BY)
    # =====================================================================
    columns_order = [
        'partner_name', 'year_month', 'promo_type', 'total_promo_cost', 'co_funding',
        'uplift_orders', 'uplift_gmv', 'incremental_orders', 'incremental_gmv',
        'roi', 'total_partner_gmv_monthly', 'partner_share_of_food_poland_gmv_pct',
    ]
    final = pd.concat([main, ke_final], ignore_index=True)
    final['partner_name'] = partner_index.to_numpy()[final['p_code'].to_numpy()]
    final['year_month'] = ym_to_str(final['ym'].to_numpy())
    final = final[columns_order]

    promo_sort = {'Total': 1, 'Key Event': 2, 'Always On Total': 3,
                  'Always On': 4, 'Other': 5, 'SME': 6}
    final['promo_sort'] = final['promo_type'].map(promo_sort).fillna(7)
    final = final.sort_values(
        by=['total_partner_gmv_monthly', 'year_month', 'promo_sort'],
        ascending=[False, True, True], kind='mergesort',
    ).drop(columns=['promo_sort'])

    print("Calculations complete!")
    return final


def _col_letter(n):
    """Convert 1-based index to sheet column letter (1 -> A, 12 -> L, 27 -> AA)."""
    string = ""
    while n > 0:
        n, remainder = divmod(n - 1, 26)
        string = chr(65 + remainder) + string
    return string


def _execute_with_backoff(request, action_name, max_retries=5):
    """Execute API request with exponential backoff on rate limits & socket timeouts."""
    for attempt in range(max_retries):
        try:
            return request.execute()
        except (HttpError, socket.timeout, TimeoutError) as e:
            if attempt < max_retries - 1:
                sleep_time = (2 ** attempt) + (random.randint(0, 1000) / 1000.0)
                print(f"  Timeout/Server error on {action_name}. Retrying in {sleep_time:.1f}s...")
                time.sleep(sleep_time)
            else:
                raise


def _sheet_values(df):
    """Convert pandas DataFrame to sheet-compatible 2D raw value matrix."""
    headers = list(df.columns)
    clean_df = df.astype(object).where(pd.notnull(df), None)
    rows = clean_df.values.tolist()
    return [headers] + [[("" if val is None else val) for val in row] for row in rows]

# ==========================================================================
# GOOGLE SHEETS OUTPUT
# ==========================================================================
WRITE_CHUNK_CELLS = 50000  # Number of cells per API write chunk to avoid payload limits
PRESERVE_COLS = 6          # M:R — user-owned columns to the right of the 12 data cols.
                           # Never cleared, never resized away, never formatted.

def _ensure_tab(svc, sheet_id, tab_name, n_rows, n_cols, extra_cols=PRESERVE_COLS):
    """Create the tab if missing, then GROW the grid. Never shrinks — shrinking
    columnCount/rowCount hard-deletes whatever lives in the preserved columns."""
    meta = _execute_with_backoff(
        svc.spreadsheets().get(spreadsheetId=sheet_id), 'get meta')
    tabs = {s['properties']['title']: s['properties'] for s in meta['sheets']}

    if tab_name not in tabs:
        _execute_with_backoff(svc.spreadsheets().batchUpdate(
            spreadsheetId=sheet_id,
            body={'requests': [{'addSheet': {'properties': {
                'title': tab_name,
                'gridProperties': {'rowCount': max(n_rows, 2),
                                   'columnCount': n_cols + extra_cols},
            }}}]}), 'addSheet')
        meta = _execute_with_backoff(
            svc.spreadsheets().get(spreadsheetId=sheet_id), 'get meta')
        tabs = {s['properties']['title']: s['properties'] for s in meta['sheets']}

    props = tabs[tab_name]
    gp = props.get('gridProperties', {})
    cur_rows = int(gp.get('rowCount', 0))
    cur_cols = int(gp.get('columnCount', 0))
    tab_gid = props['sheetId']

    want_rows = max(n_rows, cur_rows, 2)              # grow only
    want_cols = max(n_cols + extra_cols, cur_cols)    # grow only

    _execute_with_backoff(svc.spreadsheets().batchUpdate(
        spreadsheetId=sheet_id,
        body={'requests': [{'updateSheetProperties': {
            'properties': {
                'sheetId': tab_gid,
                'gridProperties': {'rowCount': want_rows,
                                   'columnCount': want_cols,
                                   'frozenRowCount': 1},
            },
            'fields': 'gridProperties(rowCount,columnCount,frozenRowCount)',
        }}]}), 'resize grid')

    return tab_gid, cur_rows


def push_to_sheet(df, sheet_id, tab_name='promo_tracker'):
    if not sheet_id:
        raise ValueError("SHEET_ID is empty — paste the id from the sheet URL.")

    creds, _ = google_auth_default(scopes=SCOPES)
    socket.setdefaulttimeout(120)
    svc = build('sheets', 'v4', credentials=creds, cache_discovery=False)

    values = _sheet_values(df)
    n_rows, n_cols = len(values), len(df.columns)
    last_col = _col_letter(n_cols)                     # 'L'
    chunk_rows = max(WRITE_CHUNK_CELLS // max(n_cols, 1), 1)
    print(f"Pushing {n_rows - 1} rows x {n_cols} cols "
          f"({(n_rows - 1) * n_cols:,} cells) in {math.ceil(n_rows / chunk_rows)} requests"
          f"  [preserving {_col_letter(n_cols + 1)}:{_col_letter(n_cols + PRESERVE_COLS)}]")

    tab_gid, prev_rows = _ensure_tab(svc, sheet_id, tab_name, n_rows, n_cols)

    # clear ONLY the data block A:L, never the whole tab
    clear_to = max(prev_rows, n_rows, 2)
    _execute_with_backoff(
        svc.spreadsheets().values().batchClear(
            spreadsheetId=sheet_id,
            body={'ranges': [f"'{tab_name}'!A1:{last_col}{clear_to}"]}), 'clear A:L')

    t0 = time.time()
    written = 0
    for i in range(0, n_rows, chunk_rows):
        chunk = values[i:i + chunk_rows]
        rng = f"'{tab_name}'!A{i + 1}:{last_col}{i + len(chunk)}"
        _execute_with_backoff(
            svc.spreadsheets().values().update(
                spreadsheetId=sheet_id,
                range=rng,
                valueInputOption='RAW',   # RAW so '2026-01' stays text, not a date
                body={'values': chunk}),
            f'rows {i + 1}-{i + len(chunk)}')
        written += len(chunk)
        print(f"  {written}/{n_rows} rows  ({time.time() - t0:.1f}s)")

    # formatting bounded to A:L — endColumnIndex stops it bleeding into M:R
    _execute_with_backoff(svc.spreadsheets().batchUpdate(
        spreadsheetId=sheet_id,
        body={'requests': [
            # Header Row Bold (Rows 0 to 1)
            {'repeatCell': {
                'range': {
                    'sheetId': tab_gid, 'startRowIndex': 0, 'endRowIndex': 1,
                    'startColumnIndex': 0, 'endColumnIndex': n_cols
                },
                'cell': {'userEnteredFormat': {'textFormat': {'bold': True}}},
                'fields': 'userEnteredFormat.textFormat.bold'
            }},
            # Date Column (Column B / indices 1-2)
            {'repeatCell': {
                'range': {
                    'sheetId': tab_gid, 'startRowIndex': 1, 'endRowIndex': n_rows,
                    'startColumnIndex': 1, 'endColumnIndex': 2
                },
                'cell': {'userEnteredFormat': {'numberFormat': {'type': 'DATE', 'pattern': 'yyyy-mm-dd'}}},
                'fields': 'userEnteredFormat.numberFormat'
            }},
            # Cols D-I (indices 3-9): Numbers (#,##0.00)
            {'repeatCell': {
                'range': {
                    'sheetId': tab_gid, 'startRowIndex': 1, 'endRowIndex': n_rows,
                    'startColumnIndex': 3, 'endColumnIndex': 9
                },
                'cell': {'userEnteredFormat': {'numberFormat': {'type': 'NUMBER', 'pattern': '#,##0.00'}}},
                'fields': 'userEnteredFormat.numberFormat'
            }},
            # Col J (index 9-10): ROI (0.00)
            {'repeatCell': {
                'range': {
                    'sheetId': tab_gid, 'startRowIndex': 1, 'endRowIndex': n_rows,
                    'startColumnIndex': 9, 'endColumnIndex': 10
                },
                'cell': {'userEnteredFormat': {'numberFormat': {'type': 'NUMBER', 'pattern': '0.00'}}},
                'fields': 'userEnteredFormat.numberFormat'
            }},
        ]}), 'format')

    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit#gid={tab_gid}"
    print(f"Done in {time.time() - t0:.1f}s -> {url}")
    return url

# ==========================================================================
# EQUIVALENCE CHECK — run this once against the old script's CSV
# ==========================================================================
def compare_outputs(old_csv, new_csv, rtol=1e-9, atol=1e-6):
    a = pd.read_csv(old_csv)
    b = pd.read_csv(new_csv)
    assert list(a.columns) == list(b.columns), "column mismatch"
    assert len(a) == len(b), f"row count {len(a)} vs {len(b)}"
    for c in ['partner_name', 'year_month', 'promo_type']:
        assert (a[c].to_numpy() == b[c].to_numpy()).all(), f"row order/keys differ on {c}"
    bad = {}
    for c in a.columns:
        if a[c].dtype.kind not in 'fi':
            continue
        x, y = a[c].to_numpy(float), b[c].to_numpy(float)
        if (np.isnan(x) != np.isnan(y)).any():
            bad[c] = 'NaN pattern'
            continue
        d = np.abs(np.nan_to_num(x) - np.nan_to_num(y))
        if (d > atol + rtol * np.abs(np.nan_to_num(x))).any():
            bad[c] = float(d.max())
    print("IDENTICAL" if not bad else f"DIFFERENCES: {bad}")
    return not bad

# ==========================================================================
# EXECUTION
# ==========================================================================
if __name__ == "__main__":
    PROJECT_ID = 'dhub-glovo'

    # from docs.google.com/spreadsheets/d/<SHEET_ID>/edit
    SHEET_ID = '1FtiXS1VYWk06D_x2kg_W7JZmDHICsTKsg_XdvXcYbEI'
    SHEET_TAB = 'Actuals'

    # local copy kept for compare_outputs() regression checks; set to None to skip
    LOCAL_CSV = 'final_promo_output.csv'

    daily, episodes, addr_map = extract_data_from_bq(PROJECT_ID)
    final_output = run_promo_calculations(daily, episodes, addr_map)

    if LOCAL_CSV:
        final_output.to_csv(LOCAL_CSV, index=False)  # NaN -> empty cell == SQL NULL
        print(f"Local copy saved as {LOCAL_CSV}")

    push_to_sheet(final_output, SHEET_ID, SHEET_TAB)

/**
 * Promo Log 2.0 - BC PULL
 *
 * Pobiera metryki Big Chain (miesięczne, per brand) z BigQuery do karty "bc".
 * Query jest ciężkie, więc działa asynchronicznie (jak Matrix):
 * - refreshBC()        startuje job w BigQuery i czeka do ~4.5 min.
 *                      Jeśli nie skończy, tworzy trigger refreshBCCollect()
 *                      co 5 min, który zapisze wynik, gdy job się skończy.
 * - refreshBCCollect() dokończenie zapisu (wywoływane automatycznie).
 * - setupBCTrigger()   opcjonalnie: automatyczny refresh codziennie ok. 06:00.
 *
 * Status widać w karcie Data_Pull_Status (wiersz "BC").
 * Wymaga usługi BigQuery (Advanced Service) – ta sama co Data_Pull.gs.
 */

var BC_SHEET = 'bc';
var BC_LABEL = 'BC';
var BC_JOB_PROPERTY = 'DATA_PULL_BC_JOB_ID';

var BC_QUERY = `
WITH date_values AS (
    SELECT DATE('2026-04-01') AS start_date
),

-- 1. MAPOWANIE NAZW
name_mapping AS (
    SELECT DISTINCT
        TRIM(t2.store_name) AS original_store_name,
        CASE
            WHEN t2.store_name LIKE '%BAFRA%' OR t2.store_name LIKE '%Bafra%' THEN 'BAFRA Kebabs'
            WHEN t2.store_name IN ("McDonald's", 'McDonalds') THEN "McDonald's"
            WHEN t2.store_name = 'KFC' THEN 'KFC'
            WHEN t2.store_name IN ('Zahir Kebab', 'Zahid Kebab', 'Noor Kebab', 'Ryżowa Buła', 'Rollo Pizza Express') THEN 'Zahir Kebab'
            WHEN t2.store_name IN ('Pizza Hut', 'Zapiekarony od Pizza Hut') THEN 'Pizza Hut'
            WHEN t2.store_name LIKE 'Domino%Pizza%' THEN "Domino's Pizza"
            WHEN t2.store_name IN ('MAX Premium Burgers', 'Zielone Menu z MAX') THEN 'MAX Premium Burgers'
            WHEN t2.store_name IN ('Pasibus', 'Pasibus Galeria Arkadia') THEN 'Pasibus'
            WHEN t2.store_name = 'Starbucks' THEN 'Starbucks'
            WHEN t2.store_name IN ('Subway by AMIC Energy', 'Pizza Sbarro by AMIC Energy', 'Subway') THEN 'Subway'
            WHEN t2.store_name IN ('Berlin Döner Kebap', 'Berlin Doner') THEN 'Berlin Döner Kebap'
            WHEN t2.store_name IN ('Thai Wok', 'Tuk Tuk', 'Tajska Micha by Thai Wok', 'Ramen & Udon by Thai Wok') THEN 'Thai Wok'
            WHEN t2.store_name IN ('T-Pizza (wcześniej Telepizza)', 'T-Pizza', 'Telepizza') THEN 'T-Pizza (wcześniej Telepizza)'

            WHEN t2.store_name IN ('Salad Story', 'WrapMe!') THEN 'Salad Story'
            WHEN t2.store_name IN ('North Fish', 'John Burg') THEN 'North Fish'
            WHEN t2.store_name IN ('Holy Taco', 'Mniamciu', 'Sznyclove', 'Przysmaki Alushy', 'Prokuratura', 'Grube Pierogi', 'Vito Calzone', 'Rano Podano', 'Wege Gang', 'Just Burgers') THEN 'Rebel Tang'
            WHEN t2.store_name = 'Green Caffè Nero' THEN 'Green Caffè Nero'
            WHEN t2.store_name = 'Papa Johns Pizza' THEN 'Papa Johns Pizza'
            WHEN t2.store_name IN ('Costa Coffee', 'SO! COFFEE') THEN 'Costa Coffee'
            WHEN t2.store_name LIKE '%Solleim%' THEN 'Solleim'
            WHEN t2.store_name LIKE 'Pizzeria 105%' THEN 'Pizzeria 105'
            WHEN t2.store_name LIKE '%Osama%Sushi%' THEN 'Osama Sushi'
            WHEN t2.store_name IN ('Burger King','Burger King®') THEN 'Burger King'
            WHEN t2.store_name LIKE LOWER('KEBAB%SUPER%KING') THEN 'Kebab Super King'
            ELSE TRIM(t2.store_name)
        END AS normalized_store_name
    FROM \`fulfillment-dwh-production.curated_data_shared_glovo.partner_scd2__stores\` t2
    WHERE t2.p_end_date = "2999-12-31"
      AND (
          t2.store_name LIKE 'Pasibus%'
          OR t2.store_name IN ('Da Grasso', 'Subway', 'Koku Sushi', 'Burger King','Burger King®', 'So Coffee', 'Kebab WrapMe!','The Pizza','SUSHIPAK')
          OR t2.store_name IN ("McDonald's", 'McDonalds', 'KFC', 'Zahir Kebab', 'Zahid Kebab', 'Noor Kebab', 'Ryżowa Buła', 'Rollo Pizza Express', 'Pizza Hut', 'Zapiekarony od Pizza Hut',  'MAX Premium Burgers', 'Zielone Menu z MAX', 'Starbucks', 'Subway by AMIC Energy', 'Pizza Sbarro by AMIC Energy', 'Berlin Döner Kebap', 'Berlin Doner', 'Thai Wok', 'Tuk Tuk', 'Tajska Micha by Thai Wok', 'Ramen & Udon by Thai Wok', 'T-Pizza (wcześniej Telepizza)', 'T-Pizza', 'Telepizza',  'Salad Story', 'WrapMe!', 'North Fish', 'John Burg', 'Green Caffè Nero', 'Papa Johns Pizza', 'Costa Coffee', 'SO! COFFEE')
          OR t2.store_name LIKE 'Domino%Pizza%'
          OR t2.store_name LIKE '%BAFRA%' OR t2.store_name LIKE '%Bafra%'
          OR t2.store_name LIKE '%Solleim%'
          OR t2.store_name LIKE LOWER('KEBAB%SUPER%KING')
          OR t2.store_name LIKE 'Pizzeria 105%'
          OR t2.store_name LIKE '%Osama%Sushi%'
      )
),

-- 2. PODSTAWOWE FINANSE
financial_raw AS (
    SELECT
        DATE_TRUNC(DATE(pnl.p_creation_date), MONTH) AS month,
        nm.normalized_store_name AS store_name,
        SUM(dhegmv_eur) AS gmv,
        SUM(delord) AS orders,
        SUM(pnl.dhegmv_eur * pnl.fxrate) AS aov_1,
        COALESCE(SUM(pnl.cm0pnl_eur), 0) AS cm0
    FROM \`fulfillment-dwh-production.curated_data_shared_glovo.financial_reports_pnl__pnl_order_level\` AS pnl
    INNER JOIN \`fulfillment-dwh-production.curated_data_shared_glovo.financial_metrics__financial_order_metrics\` AS fom
        ON pnl.order_id = fom.order_id
        AND DATE(pnl.p_creation_date) = fom.p_creation_date
    INNER JOIN name_mapping nm ON TRIM(pnl.store_name) = nm.original_store_name
    WHERE pnl.order_country_code = 'PL' AND pnl.order_vertical = 'Food'
      AND DATE(pnl.p_creation_date) >= '2023-01-01' -- ROZSZERZONE: aby LAG(12) widział 2025
      AND fom.order_final_status = 'DeliveredStatus'
    GROUP BY 1, 2
),

-- 3. PIERWSZA WARSTWA FUNKCJI OKNA
financial_intermediate AS (
    SELECT
        month,
        store_name,
        gmv AS gmv_month,
        orders AS orders_month,
        LAG(gmv, 1) OVER (PARTITION BY store_name ORDER BY month) AS gmv_prev_month,
        LAG(gmv, 12) OVER (PARTITION BY store_name ORDER BY month) AS gmv_ly_month,
        LAG(orders, 1) OVER (PARTITION BY store_name ORDER BY month) AS orders_prev_month,
        LAG(orders, 12) OVER (PARTITION BY store_name ORDER BY month) AS orders_ly_month,
        SUM(gmv) OVER (PARTITION BY store_name ORDER BY month ROWS BETWEEN 11 PRECEDING AND CURRENT ROW) AS gmv_l12m,
        LAG(aov_1, 12) OVER (PARTITION BY store_name ORDER BY month) AS aov_ly_month,
        aov_1,
        cm0
    FROM financial_raw
),

-- 4. DRUGA WARSTWA FUNKCJI OKNA
financial_trends AS (
    SELECT
        *,
        LAG(gmv_l12m, 12) OVER (PARTITION BY store_name ORDER BY month) AS gmv_l12m_prev
    FROM financial_intermediate
),

-- 5. POZOSTAŁE METRYKI
ads_rev_agg AS (
    SELECT DATE_TRUNC(revenue_attribution_month, MONTH) as month, nm.normalized_store_name as store_name, SUM(amount_eur) as total_ads_revenue
    FROM \`fulfillment-dwh-production.curated_data_shared_glovo.ads_revenue__partner_ads_sale_order_items\` ads
    JOIN name_mapping nm ON TRIM(ads.store_name) = nm.original_store_name
    WHERE country_code = 'PL' AND action IN ('Credit Note', 'Invoice') AND opportunity_status = 'Closed Won'
    GROUP BY 1, 2
),

ad_credits_agg AS (
    SELECT DATE_TRUNC(p_report_date, MONTH) as month, nm.normalized_store_name as store_name, SUM(ad_credits_consumed_eur) as ad_credits_consumed_eur
    FROM \`fulfillment-dwh-production.curated_data_shared_glovo.ads_campaign_performance__partner_daily_metrics\` t_ads
    JOIN name_mapping nm ON TRIM(t_ads.chain_name) = nm.original_store_name
    WHERE country_code = 'PL' GROUP BY 1, 2
),

gtor_agg AS (
    SELECT DATE_TRUNC(p_report_date, MONTH) as month, nm.normalized_store_name as store_name,
           SUM(total_comission_rev + total_ad_partners + total_promos_partners_3rd_parties + compensations_partners_rev) as gtor_value,
           SUM(glovo_gmv) as gmv_denom
    FROM \`fulfillment-dwh-production.curated_data_shared_glovo.take_rate__take_rate\` tr
    JOIN name_mapping nm ON TRIM(tr.store_name) = nm.original_store_name
    WHERE country_code = 'PL' AND store_vertical = 'Food' GROUP BY 1, 2
),

descriptors_agg AS (
    SELECT DATE_TRUNC(DATE(p_creation_date), MONTH) as month, nm.normalized_store_name as store_name,
           COUNT(DISTINCT CASE WHEN order_is_first_delivered_order THEN customer_id END) as nc,
           SAFE_DIVIDE(SUM(CASE WHEN order_parent_relationship_type IS NULL AND order_vertical = 'Food' THEN order_total_purchase_eur END), COUNT(DISTINCT CASE WHEN order_parent_relationship_type IS NULL AND order_vertical = 'Food' THEN order_id END)) as aov,
           COUNT(DISTINCT order_city_code) as unique_cities,
           COUNT(DISTINCT store_address_id) as active_curr
    FROM \`fulfillment-dwh-production.curated_data_shared_glovo.order_descriptors__order_descriptors_v3\` o
    JOIN name_mapping nm ON TRIM(o.store_name) = nm.original_store_name
    WHERE order_country_code = 'PL' AND order_final_status = 'DeliveredStatus' AND order_vertical = 'Food'
      AND DATE(p_creation_date) >= '2023-01-01' -- ROZSZERZONE: aby LAG(12) dla active_curr działał
    GROUP BY 1, 2
),

descriptors_with_history AS (
    SELECT
        *,
        LAG(nc, 12) OVER (PARTITION BY store_name ORDER BY month) as nc_ly,
        LAG(active_curr, 1) OVER (PARTITION BY store_name ORDER BY month) as active_curr_prev,
        LAG(active_curr, 12) OVER (PARTITION BY store_name ORDER BY month) as active_curr_ly
    FROM descriptors_agg
),

ops_metrics AS (
    SELECT DATE_TRUNC(TIMESTAMP(p_created_date), MONTH) as month, nm.normalized_store_name as store_name,
           SAFE_DIVIDE(COUNT(CASE WHEN is_cancelled_due_to_partner OR is_cancelled_store_closed_after_order_creation THEN 1 END), COUNT(DISTINCT order_id)) as cdtp,
           AVG(avoidable_wait_time_pickup_minutes) as awtp,
           SAFE_DIVIDE(COUNT(CASE WHEN is_wrong_missing_items_aggregated_clean THEN 1 END), COUNT(CASE WHEN is_delivered THEN 1 END)) as wmi,
           AVG(customer_delivery_time_minutes) as dt
    FROM \`fulfillment-dwh-production.curated_data_shared_glovo.vendor_northstar_metrics_order_level_join__order_level_northstar_metrics_join\` a
    JOIN name_mapping nm ON TRIM(a.store_name) = nm.original_store_name
    WHERE country_code = 'PL' GROUP BY 1, 2
),

uptime_agg AS (
    SELECT DATE_TRUNC(TIMESTAMP(t1.p_created_date), MONTH) as month, nm.normalized_store_name as store_name,
           SUM(actual_opening_time_minutes) / NULLIF(SUM(expected_opening_time_minutes), 0) as uptime_pct
    FROM \`fulfillment-dwh-production.curated_data_shared_glovo.vendor_northstar_metrics_store_address_level_uptime__store_address_level_uptime\` t1
    JOIN \`fulfillment-dwh-production.curated_data_shared_glovo.partner_scd2__stores\` s ON CAST(t1.store_id AS STRING) = CAST(s.store_id AS STRING) AND s.p_end_date = '2999-12-31'
    JOIN name_mapping nm ON TRIM(s.store_name) = nm.original_store_name
    WHERE t1.country_code = 'PL' GROUP BY 1, 2
),
promos_agg AS (
    SELECT DATE_TRUNC(p_creation_date, MONTH) as month, nm.normalized_store_name as store_name,
           SUM(total_promotool_discounts_partner_funded) as dgmv_pf,
           SUM(total_promotool_discounts) as gmv_disc
    FROM \`fulfillment-dwh-production.curated_data_shared_glovo.promos_okr__promos_okr_tracker_v2\` t1
    JOIN \`fulfillment-dwh-production.curated_data_shared_glovo.partner_scd2__stores\` s ON CAST(t1.store_id AS STRING) = CAST(s.store_id AS STRING) AND s.p_end_date = '2999-12-31'
    JOIN name_mapping nm ON TRIM(s.store_name) = nm.original_store_name
    WHERE t1.country_code = 'PL' AND store_vertical = 'Food' GROUP BY 1, 2
),
    loyalty_agg AS (
    SELECT
         DATE_TRUNC(DATE(l.p_month_date), MONTH) as month,
        nm.normalized_store_name AS store_name,
        AVG(l.perc_of_loyal_customers_partner) AS perc_of_loyal_customers_partner
    FROM \`fulfillment-dwh-production.curated_data_shared_glovo.customer_partner_loyalty__store_level\` AS l
    INNER JOIN name_mapping nm ON TRIM(l.store_name) = nm.original_store_name
    WHERE (l.country_code ) = 'PL'
    GROUP BY 1,2
)

-- FINAL SELECT
SELECT
    DATE(f.month) as month,
    f.store_name,
    COALESCE(o.cdtp, 0) as cdtp,
    COALESCE(o.awtp, 0) as average_awtp_mins,
    COALESCE(o.wmi, 0) as pct_wmi_aggregated_clean,
    COALESCE(u.uptime_pct, 0) as uptime_pct,
    COALESCE(ac.ad_credits_consumed_eur, 0) as ad_credits_consumed_eur,

    f.gmv_month,
    COALESCE(f.gmv_ly_month, 0) as gmv_ly_month,
    COALESCE(f.gmv_prev_month, 0) as gmv_prev_month,
    f.gmv_l12m,
    COALESCE(f.gmv_l12m_prev,0) as gmv_l12m_prev,
    SAFE_DIVIDE(f.gmv_l12m - f.gmv_l12m_prev, f.gmv_l12m_prev) as gmv_l12m_vs_prev_pct,
    SAFE_DIVIDE(f.gmv_l12m, f.gmv_l12m_prev) as gmv_l12m_ratio,
    COALESCE(SAFE_DIVIDE(f.gmv_month - f.gmv_ly_month, f.gmv_ly_month),0) as gmv_yoy_pct,

    f.orders_month as orders,
    COALESCE(SAFE_DIVIDE(f.orders_month - f.orders_prev_month, f.orders_prev_month),0) as orders_mom_pct,
    COALESCE(SAFE_DIVIDE(f.orders_month - f.orders_ly_month, f.orders_ly_month),0) as orders_yoy_pct,

    COALESCE(d.nc, 0) as new_customers,
    COALESCE(d.aov, 0) as aov,
    COALESCE(d.unique_cities, 0) as unique_cities,
    COALESCE(d.active_curr, 0) as active_store_addresses,

    -- Poprawione różnice adresów (teraz biorą dane z descriptors_with_history)
    COALESCE(d.active_curr, 0) - COALESCE(d.active_curr_prev, 0) as active_stores_mom_diff,
    COALESCE(d.active_curr, 0) - COALESCE(d.active_curr_ly, 0) as active_stores_yoy_diff,

    COALESCE(g.gtor_value, 0) as gtor,
    SAFE_DIVIDE(g.gtor_value, g.gmv_denom) as gtor_over_gmv,
    COALESCE(ads.total_ads_revenue, 0) as total_ads_revenue,
    COALESCE(p.dgmv_pf, 0) as dgmv_partner_funded,
    COALESCE(p.gmv_disc, 0) as gmv_disc,
    COALESCE(o.dt, 0) as dt,
    f.aov_1,
    f.cm0,
    COALESCE(f.aov_ly_month,0) AS aov_ly_month,
    COALESCE(d.nc_ly, 0) as new_customers_ly,
    COALESCE(SAFE_DIVIDE(d.nc - d.nc_ly, d.nc_ly),0) as new_customers_yoy_pct,
    l.perc_of_loyal_customers_partner

FROM financial_trends f
LEFT JOIN ops_metrics o ON f.month = CAST(o.month AS DATE) AND f.store_name = o.store_name
LEFT JOIN ads_rev_agg ads ON f.month = CAST(ads.month AS DATE) AND f.store_name = ads.store_name
LEFT JOIN ad_credits_agg ac ON f.month = CAST(ac.month AS DATE) AND f.store_name = ac.store_name
LEFT JOIN gtor_agg g ON f.month = CAST(g.month AS DATE) AND f.store_name = g.store_name
LEFT JOIN descriptors_with_history d ON f.month = CAST(d.month AS DATE) AND f.store_name = d.store_name
LEFT JOIN uptime_agg u ON f.month = CAST(u.month AS DATE) AND f.store_name = u.store_name
LEFT JOIN promos_agg p ON f.month = CAST(p.month AS DATE) AND f.store_name = p.store_name
LEFT JOIN loyalty_agg l ON f.month = CAST(l.month AS DATE) AND f.store_name = l.store_name

WHERE f.month >= (SELECT start_date FROM date_values)
ORDER BY f.month DESC, gmv_month DESC
`;

function refreshBC() {
  try {
    var jobId = dataPullStartJob_(BC_QUERY, BC_LABEL);
    PropertiesService.getScriptProperties().setProperty(BC_JOB_PROPERTY, jobId);
    dataPullLog_(BC_LABEL, 'RUNNING', 0, 'BigQuery job started.', jobId);

    var started = Date.now();
    while (Date.now() - started < 270000) {
      if (dataPullJobState_(jobId, BC_LABEL) === 'DONE') return bcFinish_(jobId);
      Utilities.sleep(10000);
    }

    bcScheduleCollect_();
    dataPullLog_(BC_LABEL, 'RUNNING', 0, 'Still running in BigQuery. refreshBCCollect() will write it when done.', jobId);
    return {status: 'RUNNING', jobId: jobId};
  } catch (err) {
    PropertiesService.getScriptProperties().deleteProperty(BC_JOB_PROPERTY);
    dataPullLog_(BC_LABEL, 'ERROR', 0, String(err && err.message ? err.message : err));
    throw err;
  }
}

function refreshBCCollect() {
  var props = PropertiesService.getScriptProperties();
  var jobId = props.getProperty(BC_JOB_PROPERTY);
  if (!jobId) {
    bcDeleteCollect_();
    return {status: 'NO_JOB'};
  }

  try {
    if (dataPullJobState_(jobId, BC_LABEL) !== 'DONE') {
      dataPullLog_(BC_LABEL, 'RUNNING', 0, 'Still running in BigQuery.', jobId);
      return {status: 'RUNNING', jobId: jobId};
    }
    return bcFinish_(jobId);
  } catch (err) {
    props.deleteProperty(BC_JOB_PROPERTY);
    bcDeleteCollect_();
    dataPullLog_(BC_LABEL, 'ERROR', 0, String(err && err.message ? err.message : err), jobId);
    throw err;
  }
}

function bcFinish_(jobId) {
  var result = bcFetchTypedResults_(jobId);
  bcWriteSheet_(result);
  PropertiesService.getScriptProperties().deleteProperty(BC_JOB_PROPERTY);
  bcDeleteCollect_();
  dataPullLog_(BC_LABEL, 'SUCCESS', result.values.length, 'bc refreshed successfully.', jobId);
  Logger.log('bc refreshed: ' + result.values.length + ' rows. Job: ' + jobId);
  return {status: 'SUCCESS', rows: result.values.length, jobId: jobId};
}

/**
 * Jak dataPullFetchResults_, ale konwertuje typy z BigQuery:
 * liczby -> Number (żeby polski locale nie zamienił "0.15" w tekst/datę),
 * DATE -> Date.
 */
function bcFetchTypedResults_(jobId) {
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

  var fields = schema && schema.fields ? schema.fields : [];
  var headers = fields.map(function(f) { return f.name; });
  var types = fields.map(function(f) { return String(f.type || '').toUpperCase(); });

  var values = allRows.map(function(row) {
    return row.f.map(function(cell, i) {
      var v = cell && cell.v !== undefined ? cell.v : null;
      if (v === null || v === '') return '';
      switch (types[i]) {
        case 'INTEGER': case 'INT64': case 'FLOAT': case 'FLOAT64':
        case 'NUMERIC': case 'BIGNUMERIC':
          var n = Number(v);
          return isNaN(n) ? v : n;
        case 'DATE':
          var p = String(v).split('-');
          return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
        default:
          return v;
      }
    });
  });

  return {headers: headers, types: types, values: values, jobId: jobId};
}

function bcWriteSheet_(result) {
  if (!result.headers.length) {
    throw new Error('bc: query returned no schema. Existing sheet was NOT changed.');
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(BC_SHEET);
  if (!sheet) sheet = ss.insertSheet(BC_SHEET);

  var cols = result.headers.length;
  var rows = result.values.length;

  // Nadpisujemy dopiero PO udanym jobie w BigQuery.
  sheet.clearContents();
  sheet.clearFormats();

  // Upewnij się, że arkusz ma dość wierszy/kolumn.
  if (sheet.getMaxColumns() < cols) sheet.insertColumnsAfter(sheet.getMaxColumns(), cols - sheet.getMaxColumns());
  if (sheet.getMaxRows() < rows + 1) sheet.insertRowsAfter(sheet.getMaxRows(), rows + 1 - sheet.getMaxRows());

  sheet.getRange(1, 1, 1, cols).setValues([result.headers]).setFontWeight('bold');

  if (rows) {
    // Zapis w paczkach, żeby nie przekroczyć limitów przy dużych wynikach.
    var CHUNK = 5000;
    for (var start = 0; start < rows; start += CHUNK) {
      var part = result.values.slice(start, start + CHUNK);
      sheet.getRange(start + 2, 1, part.length, cols).setValues(part);
    }

    result.types.forEach(function(t, i) {
      if (t === 'DATE') sheet.getRange(2, i + 1, rows, 1).setNumberFormat('yyyy-mm-dd');
    });
  }

  sheet.setFrozenRows(1);
  SpreadsheetApp.flush();
  return sheet;
}

function bcScheduleCollect_() {
  bcDeleteCollect_();
  ScriptApp.newTrigger('refreshBCCollect').timeBased().everyMinutes(5).create();
}

function bcDeleteCollect_() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'refreshBCCollect') ScriptApp.deleteTrigger(trigger);
  });
}

/** Opcjonalnie: codzienny automatyczny refresh karty "bc" ok. 06:00. */
function setupBCTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'refreshBC') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('refreshBC').timeBased().everyDays(1).atHour(6).create();
  Logger.log('BC trigger created: daily ~06:00.');
}

/**
 * Główny punkt wejścia aplikacji webowej
 */
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
      .evaluate()
      .setTitle('Promo Log 2.0')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}


/**
 * Pobiera unikalną listę wszystkich aktywnych partnerów z zakładek Partners
 * (Filtruje partnerów z bazy master pod kątem 90 dni, min 1 zam/dzień i przypisanego AM)
 */
function getPartnerList() {
  var partners = getPartnersMasterData_();

  // Wyciągamy nazwy partnerów i sortujemy je alfabetycznie
  var partnerNames = partners
    .map(function(p) { return p.storeName; })
    .filter(function(name) { return name !== '' && name !== null; });

  // Usuwamy ewentualne duble i sortujemy
  var uniqueNames = partnerNames.filter(function(value, index, self) {
    return self.indexOf(value) === index;
  });

  return uniqueNames.sort();
}

/**
 * Pobiera listę adresów/lokalizacji (Store Address ID) dla wybranego partnera
 */
function getPartnerAddresses(partnerName) {
  var projectId = 'dhub-glovo';

  // Store Address ID is ONLY metadata for the manager.
  // It does NOT control which products are loaded.
  var query = `
    WITH canonical_stores AS (
      SELECT DISTINCT
        CAST(store_address_id AS STRING) AS store_address_id,
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
        END AS canonical_store_name,
        store_name AS raw_store_name
      FROM \`fulfillment-dwh-production.curated_data_shared_glovo.active_partners__retention_metrics\`
      WHERE p_run_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
        AND country_code = 'PL'
        AND store_address_id IS NOT NULL
        AND store_name IS NOT NULL
        AND store_address_is_enabled = TRUE
        AND (NOT store_address_is_deleted OR store_address_is_deleted IS NULL)
        AND store_address_is_partner
        AND store_vertical = 'Food'
    )
    SELECT DISTINCT
      store_address_id,
      raw_store_name
    FROM canonical_stores
    WHERE LOWER(canonical_store_name) = LOWER(@partner_name)
    ORDER BY store_address_id ASC;
  `;

  var request = BigQuery.newQueryRequest();
  request.query = query;
  request.useLegacySql = false;
  request.parameterMode = 'NAMED';
  request.queryParameters = [{
    name: 'partner_name',
    parameterType: { type: 'STRING' },
    parameterValue: { value: partnerName }
  }];

  var queryResults = BigQuery.Jobs.query(request, projectId);
  var rows = queryResults.rows || [];

  return rows.map(function(r) {
    return {
      id: r.f[0].v,
      name: r.f[1] ? r.f[1].v : r.f[0].v
    };
  });
}

/**
 * Pobiera produkty i ich udziały GMV dla wybranego partnera
 */
function getPartnerProducts(partnerName) {
  var projectId = 'dhub-glovo';

  var query = `
    WITH dynamic_stores AS (
      SELECT DISTINCT
        CAST(store_address_id AS STRING) AS store_address_id,
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
      FROM \`fulfillment-dwh-production.curated_data_shared_glovo.active_partners__retention_metrics\`
      WHERE p_run_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
        AND country_code = 'PL'
        AND store_address_is_enabled = TRUE
        AND (NOT store_address_is_deleted OR store_address_is_deleted IS NULL)
        AND store_address_is_partner
        AND store_vertical = 'Food'
        AND (
          store_category_name IS NULL
          OR (
              store_category_name <> 'ELOGISTICS'
            AND LOWER(store_category_name) NOT LIKE '%fake%'
          )
        )
        AND store_is_enabled
        AND (NOT store_is_deleted OR store_is_deleted IS NULL)
        AND COALESCE(is_city_enabled, TRUE)
    ),
    product_sales AS (
      SELECT
        bp.product_name,
        COUNT(1) AS times_bought,
        SUM(bp.product_unit_price) AS product_gmv
      FROM \`fulfillment-dwh-production.curated_data_shared_glovo.bought_products__bought_products_v3\` bp
      JOIN dynamic_stores ds
        ON CAST(bp.store_address_id AS STRING) = ds.store_address_id
      WHERE bp.p_creation_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 70 DAY)
        AND bp.p_creation_date < CURRENT_DATE()
        AND bp.product_name IS NOT NULL
        AND LOWER(ds.store_name) = LOWER(@partner_name)
      GROUP BY bp.product_name
    )
    SELECT
      product_name,
      ROUND(SAFE_DIVIDE(product_gmv, SUM(product_gmv) OVER ()) * 100, 2) AS product_gmv_share_pct
    FROM product_sales
    ORDER BY product_gmv_share_pct DESC
    LIMIT 350;
  `;

  var request = BigQuery.newQueryRequest();
  request.query = query;
  request.useLegacySql = false;
  request.parameterMode = 'NAMED';
  request.queryParameters = [{
    name: 'partner_name',
    parameterType: { type: 'STRING' },
    parameterValue: { value: partnerName }
  }];

  var queryResults = BigQuery.Jobs.query(request, projectId);
  var rows = queryResults.rows || [];

  return rows.map(function(row) {
    return {
      product_name: row.f[0].v,
      gmv_share_pct: parseFloat(row.f[1].v)
    };
  });
}

// Lista ADMINÓW
var ADMIN_EMAILS = [
  'oliwia.korobczyc@glovoapp.com',
  'emilia.dziubinska@glovoapp.com',
  'emilia.kowalinska@glovoapp.com',
  'szymon.szczepanski@glovoapp.com',
  'jakub.suchecki@glovoapp.com',
  'riccardo.celoria@glovoapp.com'


];

function checkIsAdmin() {
  var userEmail = Session.getActiveUser().getEmail();
  return ADMIN_EMAILS.indexOf(userEmail) !== -1;
}


/**
 * ============================
 * MASTER LOG - REFERENCE DATA
 * ============================
 * Partners i Matrix są utrzymywane przez osobny Data_Pull.gs.
 * Master Log czyta wyłącznie gotowe dane z zakładek Partners i Matrix.
 */

var PARTNERS_REFERENCE_SHEET = 'Partners';
var MATRIX_REFERENCE_SHEET = 'Matrix';

function getPartnersMasterData_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('PROMO_LOG_PARTNERS_MASTER_SHEET');
  if (cached) return JSON.parse(cached);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PARTNERS_REFERENCE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 12).getValues();
  var data = rows.filter(function(r) { return r[0] !== '' && r[0] !== null; }).map(function(r) {
    return {
      storeName: r[0] == null ? '' : String(r[0]),
      segmentation: r[1] == null ? '' : String(r[1]),
      dailyGmvEur: toNumber_(r[2]),
      dailyOrders: toNumber_(r[3]),
      top3Share: toNumber_(r[8]),
      accountManager: r[9] == null ? '' : String(r[9]).trim(),
      team: r[10] == null ? '' : String(r[10]).trim(),
      teamGroup: r[11] == null ? '' : String(r[11]).trim()
    };
  });

  var json = JSON.stringify(data);
  if (data.length > 0 && json.length < 95000) cache.put('PROMO_LOG_PARTNERS_MASTER_SHEET', json, 3600);
  return data;
}

function getMatrixMasterData_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('PROMO_LOG_MATRIX_MASTER_SHEET');
  if (cached) return JSON.parse(cached);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(MATRIX_REFERENCE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 17).getValues();
  var data = rows.filter(function(r) { return r[0] !== '' && r[0] !== null; }).map(function(r) {
    return {
      key: r[0] == null ? '' : String(r[0]),
      segmentation: r[1] == null ? '' : String(r[1]),
      promoType: r[2] == null ? '' : String(r[2]),
      depthBucket: r[3] == null ? '' : String(r[3]),
      level: r[4] == null ? '' : String(r[4]),
      n: toNumber_(r[5]),
      gmvUplift: toNumber_(r[6]),
      ordersUplift: toNumber_(r[9]),
      costIntensity: toNumber_(r[10]),
      costPerPromoOrder: toNumber_(r[11]),
      penetration: toNumber_(r[12]),
      roi: toNumber_(r[13]),
      coverage: toNumber_(r[14]),
      primeShare: toNumber_(r[15]),
      promoProductsUplift: toNumber_(r[16])
    };
  });

  var json = JSON.stringify(data);
  if (data.length > 0 && json.length < 95000) cache.put('PROMO_LOG_MATRIX_MASTER_SHEET', json, 3600);
  return data;
}

function toNumber_(value) {
  if (value === null || value === '' || value === undefined) return null;
  var n = Number(value);
  return isNaN(n) ? null : n;
}

function normalizeName_(value) {
  return String(value || '').trim().toLowerCase();
}

function parseDateOnly_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  var s = String(value).trim();
  var m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  var d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dateDiffInclusive_(start, end) {
  var s = parseDateOnly_(start);
  var e = parseDateOnly_(end);
  if (!s || !e) return null;
  return Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
}

function formatUploadWeek_(start) {
  var d = parseDateOnly_(start);
  if (!d) return '';
  // Google Sheets WEEKNUM default convention: week starts Sunday.
  var firstDay = new Date(d.getFullYear(), 0, 1);
  var dayOfYear = Math.floor((d - firstDay) / 86400000) + 1;
  var firstDow = firstDay.getDay();
  return 'W' + Math.ceil((dayOfYear + firstDow) / 7);
}

function getDiscountNumber_(value) {
  // UI sends percentages as 20 / 30 / 50.
  // Calculations use decimal fractions: 0.20 / 0.30 / 0.50.
  if (value === null || value === '' || value === undefined) return null;
  var raw = String(value).trim();
  var s = raw.replace('%', '').replace(',', '.');
  var n = Number(s);
  if (isNaN(n)) return null;
  // "0.8%" is 0.8 %, not 80 %.
  if (raw.indexOf('%') !== -1) return n / 100;
  return Math.abs(n) > 1 ? n / 100 : n;
}

function percentToUi_(value) {
  if (value === null || value === '' || value === undefined) return '';
  var n = Number(value);
  if (isNaN(n)) return '';
  var pct = Math.abs(n) <= 1 ? n * 100 : n;
  return Number(pct.toFixed(2));
}

function getDepthBucket_(promoType, maxDiscount) {
  var type = String(promoType || '').trim().toUpperCase();
  if (type === 'FREE_DELIVERY' || type === 'FLAT_DELIVERY' || type === 'TWO_FOR_ONE') return '0 (none)';
  var d = getDiscountNumber_(maxDiscount);
  if (d === null || d <= 0) return '0 (none)';
  var pct = d * 100;
  if (pct <= 15) return '1-15';
  if (pct <= 20) return '16-20';
  if (pct <= 25) return '21-25';
  if (pct <= 30) return '26-30';
  if (pct <= 40) return '31-40';
  return '41+';
}

function findPartnerMaster_(partnerName, partners) {
  var wanted = normalizeName_(partnerName);
  for (var i = 0; i < partners.length; i++) {
    if (normalizeName_(partners[i].storeName) === wanted) return partners[i];
  }
  return null;
}

function findMatrix_(segmentation, promoType, depthBucket, matrix) {
  var exactKey = String(segmentation || '') + '|' + String(promoType || '') + '|' + depthBucket;
  var allDepthKey = 'ALL|' + String(promoType || '') + '|' + depthBucket;
  var allTypeKey = 'ALL|' + String(promoType || '') + '|ALL';

  var byKey = {};
  matrix.forEach(function(m) { byKey[m.key] = m; });

  return {
    row: byKey[exactKey] || byKey[allDepthKey] || byKey[allTypeKey] || null,
    key: byKey[exactKey] ? exactKey : (byKey[allDepthKey] ? allDepthKey : (byKey[allTypeKey] ? allTypeKey : exactKey))
  };
}

function calculateMasterLog_(promoData) {
  var partners = getPartnersMasterData_();
  var matrix = getMatrixMasterData_();

  var partner = findPartnerMaster_(promoData.partnerName, partners);
  var segmentation = partner ? partner.segmentation : '';
  var startDate = parseDateOnly_(promoData.startDate);
  var endDate = parseDateOnly_(promoData.endDate);
  var duration = dateDiffInclusive_(promoData.startDate, promoData.endDate);

  var standardDiscount = getDiscountNumber_(promoData.discount);
  var bppDiscount = getDiscountNumber_(promoData.bppDiscount);
  var maxDiscount = (String(promoData.promoStrategy || '').trim().toUpperCase() === 'BPP' && bppDiscount !== null)
    ? bppDiscount
    : standardDiscount;

  var depthBucket = getDepthBucket_(promoData.promoType, maxDiscount);
  var matrixResult = findMatrix_(segmentation, promoData.promoType, depthBucket, matrix);
  var mx = matrixResult.row;

  var top3Multiplier = partner && partner.top3Share !== null ? partner.top3Share : 1;
  var isTop3 = String(promoData.budgetSource || '').trim().toLowerCase() === 'top 3 test';

  var baselineMultiplier = isTop3 ? top3Multiplier : 1;
  var baselineGmv = partner && duration !== null ? partner.dailyGmvEur * duration * baselineMultiplier : null;
  var baselineOrders = partner && duration !== null ? partner.dailyOrders * duration * baselineMultiplier : null;

  var coverage = getDiscountNumber_(promoData.coverage);
  var typeUpper = String(promoData.promoType || '').trim().toUpperCase();

  // Surowy mnożnik uplift produktów z macierzy (kolumna Q). Wartości < 1 traktujemy jak brak danych.
  var promoProductsUplift = mx ? mx.promoProductsUplift : null;
  var validPromoProductsUplift = promoProductsUplift !== null && promoProductsUplift >= 1 ? promoProductsUplift : null;
  var promoOrdersPct = mx ? mx.penetration : null;
  var costIntensity = mx ? mx.costIntensity : null;

  var primeShare = 0;
  if (String(promoData.promoStrategy || '').trim().toUpperCase() === 'BPP') {
    primeShare = mx && mx.primeShare !== null ? mx.primeShare : 0.408;
  }

  // Tak jak arkusz "Forecast your PROMOS performance" (G18/G19/G30): dla promocji produktowych
  // uplift z macierzy skalujemy stosunkiem coverage promocji do historycznego coverage.
  // *1.1 to korekta upliftu GMV z arkusza, nakładana tylko na przyrost.
  var coverageScale = getCoverageScale_(typeUpper, coverage, mx, validPromoProductsUplift, maxDiscount);
  var gmvUplift = mx && mx.gmvUplift !== null ? 1 + (mx.gmvUplift - 1) * coverageScale * 1.1 : null;
  var ordersUplift = mx && mx.ordersUplift !== null ? 1 + (mx.ordersUplift - 1) * coverageScale : null;

  var forecastedGmv = baselineGmv !== null && gmvUplift !== null ? baselineGmv * gmvUplift : null;
  var forecastedOrders = baselineOrders !== null && ordersUplift !== null ? baselineOrders * ordersUplift : null;
  var upliftGmv = baselineGmv !== null && gmvUplift !== null ? baselineGmv * (gmvUplift - 1) : null;
  var upliftOrders = baselineOrders !== null && ordersUplift !== null ? baselineOrders * (ordersUplift - 1) : null;

  // upliftGmv/upliftOrders already include the full promo duration because
  // baselineGmv/baselineOrders are calculated for the selected duration.
  // Therefore duration must NOT be multiplied a second time here.
  var incrementalGmv = upliftGmv !== null ? upliftGmv * 0.4 : null;
  var incrementalOrders = upliftOrders !== null ? upliftOrders * 0.4 : null;

  var estimatedPromoCost = null;
  if (partner) {
    estimatedPromoCost = estimatePromoCost_({
      type: typeUpper,
      coverage: coverage,
      promoProductsUplift: validPromoProductsUplift,
      penetration: promoOrdersPct,
      costIntensity: costIntensity,
      costPerPromoOrder: mx ? mx.costPerPromoOrder : null,
      baselineGmv: baselineGmv,
      baselineOrders: baselineOrders,
      forecastedGmv: forecastedGmv,
      forecastedOrders: forecastedOrders,
      standardDiscount: standardDiscount,
      maxDiscount: maxDiscount,
      primeShare: primeShare,
      mbs: toNumber_(promoData.mbs)
    });
  }

  var cofunding = getDiscountNumber_(promoData.cofunding);

  // Zgodnie z formułą: AL * M (Estimated promo cost * Co-funding)
  var estimatedBudgetSpend = (estimatedPromoCost !== null && cofunding !== null)
    ? estimatedPromoCost * cofunding
    : null;

  return {
    uploadWeek: formatUploadWeek_(promoData.startDate),
    coverage: coverage,
    duration: duration,
    segmentation: segmentation,
    maxDiscount: maxDiscount,
    matrixKey: matrixResult.key,
    gmvUpliftMultiplier: gmvUplift,
    ordersUpliftMultiplier: ordersUplift,
    promoProductsUpliftMultiplier: promoProductsUplift,
    promoOrdersPct: promoOrdersPct,
    costIntensity: costIntensity,
    baselineGmv: baselineGmv,
    baselineOrders: baselineOrders,
    primeShare: primeShare,
    forecastedGmv: forecastedGmv,
    forecastedOrders: forecastedOrders,
    upliftGmv: upliftGmv,
    upliftOrders: upliftOrders,
    incrementalGmv: incrementalGmv,
    incrementalOrders: incrementalOrders,
    estimatedPromoCost: estimatedPromoCost,
    estimatedBudgetSpend: estimatedBudgetSpend,
    top3Multiplier: top3Multiplier,
    matrixLevel: mx ? mx.level : '',
    matrixN: mx ? mx.n : null,
    coverageScale: coverageScale,
    penetration: promoOrdersPct,
    cofunding: cofunding
  };
}

/**
 * Skala upliftu dla promocji produktowych (PERCENTAGE_DISCOUNT, TWO_FOR_ONE), jak G30 w arkuszu forecast:
 * coverage promocji / historyczne coverage, max 3. Historyczne coverage odtwarzamy z macierzy:
 * cost_intensity * uplift_mult / (rabat * promo_products_uplift). Brak danych => 1 (bez skalowania).
 */
function getCoverageScale_(typeUpper, coverage, mx, promoProductsUplift, maxDiscount) {
  if (typeUpper !== 'PERCENTAGE_DISCOUNT' && typeUpper !== 'TWO_FOR_ONE') return 1;
  if (!mx || !coverage || promoProductsUplift === null || promoProductsUplift <= 1) return 1;
  if (mx.costIntensity === null || mx.gmvUplift === null) return 1;
  var discount = typeUpper === 'TWO_FOR_ONE' ? 0.5 : maxDiscount;
  if (!discount) return 1;
  var historicalCoverage = mx.costIntensity * mx.gmvUplift / (discount * promoProductsUplift);
  if (!(historicalCoverage > 0)) return 1;
  return Math.min(3, coverage / historicalCoverage);
}

/**
 * Koszt promocji, jak H5 w arkuszu forecast. Puste MBS traktujemy jak arkusz (MBS = 1).
 */
function estimatePromoCost_(c) {
  var mix = (c.standardDiscount !== null && c.maxDiscount !== null)
    ? (1 - c.primeShare) * c.standardDiscount + c.primeShare * c.maxDiscount
    : null;
  var fallback = (c.forecastedGmv !== null && c.costIntensity !== null) ? c.forecastedGmv * c.costIntensity : null;

  if (c.type === 'BASKET_PERCENTAGE') {
    if (c.forecastedOrders === null || !c.baselineOrders || c.baselineGmv === null || mix === null) return null;
    var aov = c.baselineGmv / c.baselineOrders;
    var mbs = c.mbs ? c.mbs : 1;
    var qualifyingShare = c.penetration !== null ? c.penetration : Math.pow(Math.min(1, aov / mbs), 1.5);
    return c.forecastedOrders * qualifyingShare * Math.max(aov, mbs) * mix;
  }

  if (c.type === 'FREE_DELIVERY') {
    if (c.forecastedOrders !== null && c.penetration !== null && c.costPerPromoOrder !== null) {
      return c.forecastedOrders * c.penetration * c.costPerPromoOrder;
    }
    return fallback;
  }

  if (c.type === 'TWO_FOR_ONE') {
    if (c.promoProductsUplift === null || !c.coverage || c.baselineGmv === null) return fallback;
    return c.baselineGmv * c.coverage * c.promoProductsUplift * 0.5;
  }

  if (c.type === 'PERCENTAGE_DISCOUNT') {
    if (c.baselineGmv === null || mix === null) return null;
    return c.baselineGmv * (c.coverage ? c.coverage : 1) *
      (c.promoProductsUplift !== null ? c.promoProductsUplift : 1) * mix;
  }

  return fallback;
}

// AR = MBS € (Min. Basket Size), dodane po AQ (Upload Person).
var MBS_COLUMN = 44;

function ensureMbsColumn_(sheet) {
  if (sheet.getMaxColumns() < MBS_COLUMN) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), MBS_COLUMN - sheet.getMaxColumns());
  }
  var header = sheet.getRange(1, MBS_COLUMN);
  if (!header.getValue()) header.setValue('MBS €');
}

/**
 * Kalkulator forecastu (zakładka Promo Forecast i podgląd w Create Promo).
 * Liczy to samo co calculateMasterLog_, ale niczego nie zapisuje.
 */
function getPromoForecast(promoData) {
  var calc = calculateMasterLog_(promoData);
  var cost = calc.estimatedPromoCost;
  var cofunding = calc.cofunding;

  calc.roi = cost ? calc.upliftGmv / cost : null;
  calc.paidByGlovo = cost !== null && cofunding !== null ? cost * cofunding : null;
  calc.paidByPartner = cost !== null && cofunding !== null ? cost * (1 - cofunding) : null;
  calc.upliftOrdersPct = calc.baselineOrders ? calc.upliftOrders / calc.baselineOrders : null;
  calc.costPerUpliftOrder = cost !== null && calc.upliftOrders > 0 ? cost / calc.upliftOrders : null;
  calc.baselineAov = calc.baselineOrders ? calc.baselineGmv / calc.baselineOrders : null;
  calc.partnerFound = calc.baselineGmv !== null;
  return calc;
}

function ensureMasterLogHeader_(sheet) {
  var headers = [
    'ID', 'Created At', 'Status', 'Top 3 test or BP budget?', 'Partner Name', 'Store Address ID',
    'Promo Purpose', 'Pitched !!!', 'Confirmed to activate the promo', 'Start Date', 'End Date',
    'Promo Type', 'Promo Strategy', 'Standard discount', 'BPP discount', 'Products on promo',
    'Co-funding', 'Upload week', 'Menu Coverage', 'Duration (d)', 'Segmentation',
    'Max Discount', 'Matrix Key', 'GMV Uplift Multiplier', 'Orders Uplift Multiplier',
    'Promo Products Uplift Mult', '% promo orders', 'Cost Intensity', 'Baseline GMV',
    'Baseline orders', 'Prime Share', 'forecasted total GMV during promo',
    'forecasted total orders during promo', 'Uplift GMV', 'Uplift Orders',
    'Incremental GMV', 'Incremental Orders', 'Estimated promo cost', 'Estimated Budget Spend',
    'Account Manager', 'Top 3 test multiplier'
  ];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return headers.length;
}

function writeCalculatedColumns_(sheet, rowIndex, calc) {
  // R:AM = 22 calculated fields. AN remains Account Manager.
  sheet.getRange(rowIndex, 18, 1, 22).setValues([[
    calc.uploadWeek,
    calc.coverage,
    calc.duration,
    calc.segmentation,
    calc.maxDiscount,
    calc.matrixKey,
    calc.gmvUpliftMultiplier,
    calc.ordersUpliftMultiplier,
    calc.promoProductsUpliftMultiplier,
    calc.promoOrdersPct,
    calc.costIntensity,
    calc.baselineGmv,
    calc.baselineOrders,
    calc.primeShare,
    calc.forecastedGmv,
    calc.forecastedOrders,
    calc.upliftGmv,
    calc.upliftOrders,
    calc.incrementalGmv,
    calc.incrementalOrders,
    calc.estimatedPromoCost,
    calc.estimatedBudgetSpend
  ]]);

  // AO = Top 3 test share of GMV for WAW/KRA/WRO/POZ.
  sheet.getRange(rowIndex, 41).setValue(calc.top3Multiplier);

  // Percentage formatting. Values are stored as decimal fractions.
  sheet.getRange(rowIndex, 14, 1, 2).setNumberFormat('0%');       // N:O
  sheet.getRange(rowIndex, 17).setNumberFormat('0%');             // Q
  sheet.getRange(rowIndex, 19).setNumberFormat('0.0%');           // S
  sheet.getRange(rowIndex, 22).setNumberFormat('0%');             // V
  sheet.getRange(rowIndex, 27, 1, 2).setNumberFormat('0.0%');     // AA:AB
  sheet.getRange(rowIndex, 31).setNumberFormat('0.0%');           // AE
  sheet.getRange(rowIndex, 41).setNumberFormat('0.0%');           // AO

  // Currency formatting.
  sheet.getRange(rowIndex, 29, 1, 2).setNumberFormat('€#,##0.00'); // AC:AD
  sheet.getRange(rowIndex, 32, 1, 2).setNumberFormat('€#,##0.00'); // AF:AG
  sheet.getRange(rowIndex, 34).setNumberFormat('€#,##0.00');      // AH
  sheet.getRange(rowIndex, 36).setNumberFormat('€#,##0.00');      // AJ
  sheet.getRange(rowIndex, 38, 1, 2).setNumberFormat('€#,##0.00'); // AL:AM
}

function submitPromotionToMasterLog(promoData) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Master_Log');

  if (!sheet) sheet = ss.insertSheet('Master_Log', 0);
  ensureMasterLogHeader_(sheet);

  var id = 'PROMO-' + new Date().getTime();
  var userEmail = Session.getActiveUser().getEmail();
  var createdAt = Utilities.formatDate(new Date(), "GMT+2", "yyyy-MM-dd HH:mm");
  var nextRow = sheet.getLastRow() + 1;

  var partnerMaster = findPartnerMaster_(promoData.partnerName, getPartnersMasterData_());

  // Promocja ustawiana samodzielnie przez AM (nie przez Promobota) służy tylko do
  // statystyk, więc pomija kolejkę approvali i od razu jest zaakceptowana.
  var isSelfSetupAM = String(promoData.activationMethod || '').trim().toLowerCase() === 'am';

  var baseValues = new Array(43).fill('');
  baseValues[0] = id;
  baseValues[1] = createdAt;
  baseValues[2] = isSelfSetupAM ? 'APPROVED' : 'PENDING_APPROVAL';
  baseValues[3] = promoData.budgetSource;
  baseValues[4] = promoData.partnerName;
  baseValues[5] = promoData.storeAddressId || 'ALL';
  baseValues[6] = promoData.promoPurpose;
  baseValues[7] = promoData.pitched || 'Yes';
  baseValues[8] = promoData.confirmed || 'No';
  baseValues[9] = promoData.startDate;
  baseValues[10] = promoData.endDate;
  baseValues[11] = promoData.promoType;
  baseValues[12] = promoData.promoStrategy;
  baseValues[13] = getDiscountNumber_(promoData.discount);
  baseValues[14] = getDiscountNumber_(promoData.bppDiscount);
  baseValues[15] = promoData.products;
  baseValues[16] = getDiscountNumber_(promoData.cofunding);
  baseValues[39] = partnerMaster ? partnerMaster.accountManager : '';
  baseValues[41] = promoData.activationMethod;
  baseValues[40] = '';
  baseValues[42] = userEmail;

  sheet.getRange(nextRow, 1, 1, 43).setValues([baseValues]);
  ensureMbsColumn_(sheet);
  sheet.getRange(nextRow, MBS_COLUMN).setValue(toNumber_(promoData.mbs) || '');

  var calc = calculateMasterLog_(promoData);
  writeCalculatedColumns_(sheet, nextRow, calc);

  // Promos whose Promo Purpose matches a seasonal tracker (BTU, Christmas, ...)
  // are also upserted into that tracker: On promo? -> Yes, Linked Promo ID set,
  // and a brand-new row appended (Source: "Added from Card 1") if the partner
  // wasn't already sitting in the tracker.
  var matchingTrackerSheet = trackerSheetForPromoPurpose_(promoData.promoPurpose);
  if (matchingTrackerSheet) {
    try {
      upsertTrackerPartnerFromPromo_(matchingTrackerSheet, promoData, id, nextRow);
    } catch (e) {
      Logger.log(matchingTrackerSheet + ' tracker update failed: ' + e.message);
    }
  }

  // Self-setup AM promos are APPROVED immediately (see isSelfSetupAM above),
  // so this is the only time they'll ever qualify for Prime Partners -
  // promos awaiting admin approval get checked in updatePromoStatus instead.
  if (isSelfSetupAM) {
    try {
      upsertPrimePartnerRow_(
        promoData.partnerName, promoData.storeAddressId || 'ALL',
        partnerMaster ? partnerMaster.accountManager : '',
        promoData.startDate, promoData.endDate,
        promoData.promoStrategy, getDiscountNumber_(promoData.bppDiscount),
        getDiscountNumber_(promoData.discount),
        promoData.promoPurpose, id
      );
    } catch (e) {
      Logger.log('Prime Partners update failed: ' + e.message);
    }
  }

  return { status: 'SUCCESS', id: id, calculations: calc };
}

function submitMultiplePromotionsToMasterLog(promotions) {
  if (!Array.isArray(promotions) || promotions.length === 0) {
    throw new Error('No promotions to submit.');
  }

  var results = [];

  promotions.forEach(function(promoData) {
    results.push(
      submitPromotionToMasterLog(promoData)
    );
  });

  return {
    status: 'SUCCESS',
    count: results.length,
    ids: results.map(function(r) {
      return r.id;
    })
  };
}

/**
 * Aktualizuje szczegóły promocji edytowanej z poziomu okna Popup
 */
function updatePromotionDetails(rowIdx, promoData) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Master_Log');
  if (!sheet) return { status: 'ERROR' };

  ensureMasterLogHeader_(sheet);

  // 1. Sprawdzamy obecny status
  var currentStatus = String(sheet.getRange(rowIdx, 3).getValue()).toUpperCase();

  // 2. Jeśli edytujemy odrzuconą promocję (REJECTED), przywracamy ją do kolejki PENDING
  if (currentStatus === 'REJECTED') {
    sheet.getRange(rowIdx, 3).setValue('PENDING_APPROVAL');
  }

  // Confirmed odzwierciedla wybór AM-a z formularza edycji, również przy
  // wracaniu z REJECTED do PENDING_APPROVAL.
  if (promoData.confirmed !== undefined) {
    sheet.getRange(rowIdx, 9).setValue(promoData.confirmed);
  }

  // 3. Zapisujemy zmienione polami dane
  sheet.getRange(rowIdx, 4).setValue(promoData.budgetSource);
  sheet.getRange(rowIdx, 5).setValue(promoData.partnerName);
  sheet.getRange(rowIdx, 6).setValue(promoData.storeAddressId);
  sheet.getRange(rowIdx, 7).setValue(promoData.promoPurpose);
  if (promoData.pitched !== undefined) sheet.getRange(rowIdx, 8).setValue(promoData.pitched);
  sheet.getRange(rowIdx, 10).setValue(promoData.startDate);
  sheet.getRange(rowIdx, 11).setValue(promoData.endDate);
  sheet.getRange(rowIdx, 12).setValue(promoData.promoType);
  sheet.getRange(rowIdx, 13).setValue(promoData.promoStrategy);
  sheet.getRange(rowIdx, 14).setValue(getDiscountNumber_(promoData.discount));
  sheet.getRange(rowIdx, 15).setValue(getDiscountNumber_(promoData.bppDiscount));
  if (promoData.products !== undefined) sheet.getRange(rowIdx, 16).setValue(promoData.products);
  sheet.getRange(rowIdx, 17).setValue(getDiscountNumber_(promoData.cofunding));

  // MBS: formularz edycji go nie ma, więc zachowujemy zapisane MBS do przeliczenia.
  ensureMbsColumn_(sheet);
  if (promoData.mbs !== undefined) {
    sheet.getRange(rowIdx, MBS_COLUMN).setValue(toNumber_(promoData.mbs) || '');
  } else {
    promoData.mbs = sheet.getRange(rowIdx, MBS_COLUMN).getValue();
  }

  // 4. Przeliczamy na nowo metryki
  var calc = calculateMasterLog_(promoData);
  writeCalculatedColumns_(sheet, rowIdx, calc);

  return { status: 'SUCCESS', calculations: calc };
}

/**
 * Buduje promoData (wejście calculateMasterLog_) z wiersza Master_Log.
 */
function masterRowToPromoData_(row) {
  return {
    budgetSource: row[3],
    partnerName: row[4],
    storeAddressId: row[5],
    promoPurpose: row[6],
    startDate: row[9],
    endDate: row[10],
    promoType: row[11],
    promoStrategy: row[12],
    discount: row[13],
    bppDiscount: row[14],
    products: row[15],
    cofunding: row[16],
    coverage: row[18],
    mbs: row[MBS_COLUMN - 1]
  };
}

/**
 * Opcjonalnie: przelicza wszystkie istniejące wiersze Master_Log.
 */
function recalculateAllMasterLog() {
  var started = Date.now();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Master_Log');
  if (!sheet || sheet.getLastRow() < 2) return { status: 'SUCCESS', rows: 0 };

  ensureMasterLogHeader_(sheet);
  ensureMbsColumn_(sheet);
  var totalRows = sheet.getLastRow() - 1;
  var data = sheet.getRange(2, 1, totalRows, MBS_COLUMN).getValues();

  // Partners i Matrix wczytujemy raz, a nie dla każdego wiersza.
  var partners = getPartnersMasterData_();
  var matrix = getMatrixMasterData_();
  getPartnersMasterData_ = function() { return partners; };
  getMatrixMasterData_ = function() { return matrix; };

  var calculated = [];
  var top3 = [];
  var count = 0;

  data.forEach(function(row) {
    if (!row[4]) {
      // Wiersz bez partnera: R:AM i AO bez zmian.
      calculated.push(row.slice(17, 39));
      top3.push([row[40]]);
      return;
    }
    var calc = calculateMasterLog_(masterRowToPromoData_(row));
    calculated.push([
      calc.uploadWeek, calc.coverage, calc.duration, calc.segmentation, calc.maxDiscount,
      calc.matrixKey, calc.gmvUpliftMultiplier, calc.ordersUpliftMultiplier,
      calc.promoProductsUpliftMultiplier, calc.promoOrdersPct, calc.costIntensity,
      calc.baselineGmv, calc.baselineOrders, calc.primeShare, calc.forecastedGmv,
      calc.forecastedOrders, calc.upliftGmv, calc.upliftOrders, calc.incrementalGmv,
      calc.incrementalOrders, calc.estimatedPromoCost, calc.estimatedBudgetSpend
    ]);
    top3.push([calc.top3Multiplier]);
    count++;
    if (count % 500 === 0) Logger.log('Przeliczono ' + count + ' wierszy...');
  });

  // Jeden zapis zamiast zapisu wiersz po wierszu.
  sheet.getRange(2, 18, totalRows, 22).setValues(calculated);
  sheet.getRange(2, 41, totalRows, 1).setValues(top3);

  // Formatowanie kolumn raz dla całego zakresu.
  sheet.getRange(2, 14, totalRows, 2).setNumberFormat('0%');        // N:O
  sheet.getRange(2, 17, totalRows, 1).setNumberFormat('0%');        // Q
  sheet.getRange(2, 19, totalRows, 1).setNumberFormat('0.0%');      // S
  sheet.getRange(2, 22, totalRows, 1).setNumberFormat('0%');        // V
  sheet.getRange(2, 27, totalRows, 2).setNumberFormat('0.0%');      // AA:AB
  sheet.getRange(2, 31, totalRows, 1).setNumberFormat('0.0%');      // AE
  sheet.getRange(2, 41, totalRows, 1).setNumberFormat('0.0%');      // AO
  sheet.getRange(2, 29, totalRows, 2).setNumberFormat('€#,##0.00'); // AC:AD
  sheet.getRange(2, 32, totalRows, 2).setNumberFormat('€#,##0.00'); // AF:AG
  sheet.getRange(2, 34, totalRows, 1).setNumberFormat('€#,##0.00'); // AH
  sheet.getRange(2, 36, totalRows, 1).setNumberFormat('€#,##0.00'); // AJ
  sheet.getRange(2, 38, totalRows, 2).setNumberFormat('€#,##0.00'); // AL:AM

  Logger.log('Przeliczono wierszy: ' + count + ' z ' + totalRows + ' w ' +
    Math.round((Date.now() - started) / 1000) + ' s');
  return { status: 'SUCCESS', rows: count };
}


/**
 * Szybkie przeliczenie WYŁĄCZNIE kolumn AL (Estimated promo cost) i AM (Estimated Budget Spend)
 */
function recalculateCostsOnly() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Master_Log');
  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var totalRows = lastRow - 1;

  // Pobieramy zakres od A2 do AR{lastRow} (AR = MBS)
  ensureMbsColumn_(sheet);
  var values = sheet.getRange(2, 1, totalRows, MBS_COLUMN).getValues();

  var updatesCost = [];
  var updatesSpend = [];

  values.forEach(function(row) {
    var estimatedPromoCost = '';
    var estimatedBudgetSpend = '';

    if (row[4] && String(row[4]).trim() !== '') {
      // Ta sama logika co przy dodawaniu promocji (calculateMasterLog_), żeby koszty się nie rozjeżdżały.
      var calc = calculateMasterLog_(masterRowToPromoData_(row));
      if (calc.estimatedPromoCost !== null) estimatedPromoCost = calc.estimatedPromoCost;
      if (calc.estimatedBudgetSpend !== null) estimatedBudgetSpend = calc.estimatedBudgetSpend;
    }

    updatesCost.push([estimatedPromoCost]);
    updatesSpend.push([estimatedBudgetSpend]);
  });

  // Wpisujemy obliczone wartości do kolumn AL (38) i AM (39)
  sheet.getRange(2, 38, totalRows, 1).setValues(updatesCost).setNumberFormat('€#,##0.00');
  sheet.getRange(2, 39, totalRows, 1).setValues(updatesSpend).setNumberFormat('€#,##0.00');

  Logger.log('Przeliczono pomyślnie ' + totalRows + ' wierszy.');
}

/**
 * Odtwarza brakujące Menu Coverage (kolumna S) z zapisem paczkami na żywo
 */
function backfillMissingCoverage() {
  Logger.log('=== START: Rozpoczynam odtwarzanie Menu Coverage ===');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Master_Log');
  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var totalRows = lastRow - 1;
  Logger.log('Pobieram dane dla ' + totalRows + ' wierszy...');

  var data = sheet.getRange(2, 1, totalRows, 19).getValues();

  var coverageUpdates = [];
  var updatedCount = 0;
  var cachePartners = {}; // Cache produktów, żeby nie pytać bazy 10 razy o tego samego partnera

  data.forEach(function(row, index) {
    var rowNum = index + 2;
    var partnerName = String(row[4] || '').trim();  // E
    var promoType = String(row[11] || '').trim().toUpperCase(); // L
    var rawProducts = String(row[15] || '').trim(); // P
    var currentCoverage = row[18]; // S

    // Jeśli BASKET_PERCENTAGE -> 100%
    if (promoType === 'BASKET_PERCENTAGE') {
      coverageUpdates.push([1.0]);
      updatedCount++;
      return;
    }

    if ((currentCoverage === '' || currentCoverage === null) && partnerName && rawProducts && rawProducts !== 'ALL MENU') {

      // Pobieramy z cache lub z bazy
      if (!cachePartners[partnerName]) {
        cachePartners[partnerName] = getPartnerProducts(partnerName) || [];
      }
      var partnerProducts = cachePartners[partnerName];

      var selectedProductNames = rawProducts.split(',').map(function(p) { return p.trim().toLowerCase(); });
      var totalGmvShare = 0;

      partnerProducts.forEach(function(prod) {
        var name = String(prod.product_name || '').trim().toLowerCase();
        if (selectedProductNames.indexOf(name) !== -1) {
          totalGmvShare += (Number(prod.gmv_share_pct) || 0);
        }
      });

      var calculatedCoverage = totalGmvShare > 0 ? (totalGmvShare / 100) : '';
      coverageUpdates.push([calculatedCoverage]);

      if (calculatedCoverage !== '') {
        updatedCount++;
        Logger.log('Wiersz ' + rowNum + ' [' + partnerName + ']: Wyliczono Coverage = ' + totalGmvShare.toFixed(2) + '%');
      }

    } else {
      coverageUpdates.push([currentCoverage]);
    }

    // Co 100 wierszy zapisujemy paczkę do arkusza na żywo!
    if (coverageUpdates.length % 100 === 0 || index === totalRows - 1) {
      var startBatchRow = 2 + index - coverageUpdates.length + 1;
      sheet.getRange(startBatchRow, 19, coverageUpdates.length, 1).setValues(coverageUpdates).setNumberFormat('0.0%');
      coverageUpdates = []; // czyszczenie bufora
      SpreadsheetApp.flush(); // wymuszenie natychmiastowej aktualizacji arkusza
      Logger.log('---> Zapisano paczkę danych do wiersza ' + rowNum);
    }
  });

  Logger.log('=== ZAKOŃCZONO: Uzupełniono ' + updatedCount + ' wierszy. Uruchamiam koszty... ===');
  recalculateCostsOnly();
}


/**
 * Zmienia status promocji oraz wysyła e-mail do Upload Person w przypadku odrzucenia
 */
function updatePromoStatus(rowIndex, newStatus) {
  if (!checkIsAdmin()) {
    throw new Error('Brak uprawnień do zmiany statusu.');
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Master_Log');

  if (sheet) {
    sheet.getRange(rowIndex, 3).setValue(newStatus);

    if (newStatus === 'APPROVED') {
      sheet.getRange(rowIndex, 9).setValue('Yes');

      try {
        var primeRow = sheet.getRange(rowIndex, 1, 1, 43).getValues()[0];
        var primePartnerMaster = findPartnerMaster_(String(primeRow[4] || ''), getPartnersMasterData_());
        upsertPrimePartnerRow_(
          primeRow[4], primeRow[5],
          primePartnerMaster ? primePartnerMaster.accountManager : (primeRow[39] || ''),
          primeRow[9], primeRow[10], primeRow[12], primeRow[14], primeRow[13], primeRow[6], primeRow[0]
        );
      } catch (e) {
        Logger.log('Prime Partners update failed: ' + e.message);
      }
    } else if (newStatus === 'REJECTED') {
      sheet.getRange(rowIndex, 9).setValue('No');

      // Odczytujemy dane promocji, aby wysłać powiadomienie do Upload Person
      var row = sheet.getRange(rowIndex, 1, 1, 43).getValues()[0];
      var promoId = String(row[0] || '');
      var partnerName = String(row[4] || '');
      var promoPurpose = String(row[6] || '');
      var startDate = row[9] instanceof Date ? Utilities.formatDate(row[9], "GMT+2", "yyyy-MM-dd") : String(row[9] || '');
      var endDate = row[10] instanceof Date ? Utilities.formatDate(row[10], "GMT+2", "yyyy-MM-dd") : String(row[10] || '');

      // E-mail pobierany z Upload Person (kolumna AQ - row[42]).
      // Jeśli puste, robi fallback do AM (kolumna AN - row[39]).
      var uploadPersonEmail = String(row[42] || row[39] || '').trim();

      // Ostatni fallback: dla promocji zapisanych zanim kolumna AN (Account
      // Manager) zaczęła się wypełniać, sprawdzamy AM przypisanego do
      // partnera na żywo w arkuszu Partners.
      if (!uploadPersonEmail) {
        var fallbackPartner = findPartnerMaster_(partnerName, getPartnersMasterData_());
        uploadPersonEmail = fallbackPartner ? String(fallbackPartner.accountManager || '').trim() : '';
      }

      if (uploadPersonEmail && uploadPersonEmail.indexOf('@') !== -1) {
        var subject = "Promo Log 2.0: Twoja promocja została odrzucona (" + partnerName + ")";
        var body = "Cześć,\n\n" +
                   "Informujemy, że zgłoszona przez Ciebie promocja została ODRZUCONA w systemie Promo Log 2.0.\n\n" +
                   "Szczegóły odrzuconej promocji:\n" +
                   "• ID Promocji: " + promoId + "\n" +
                   "• Partner: " + partnerName + "\n" +
                   "• Cel promocji: " + promoPurpose + "\n" +
                   "• Termin: " + startDate + " - " + endDate + "\n\n" +
                   "Status promocji został zaktualizowany na REJECTED w historii kampanii.\n\n" +
                   "Pozdrawiamy,\nSystem Promo Log 2.0";

        try {
          GmailApp.sendEmail(uploadPersonEmail, subject, body);
        } catch (e) {
          Logger.log('Wysyłka e-maila do Upload Person nie powiodła się: ' + e.message);
        }
      }
    }
  }
  return { status: 'SUCCESS' };
}

function deletePromotion(rowIndex) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Master_Log');

  if (!sheet) {
    throw new Error('Master_Log not found.');
  }

  if (!rowIndex || rowIndex < 2 || rowIndex > sheet.getLastRow()) {
    throw new Error('Invalid promotion row.');
  }

  sheet.deleteRow(Number(rowIndex));

  return { status: 'SUCCESS' };
}

/**
 * Zapisuje zgłoszenie z Karty 5 (Partner_Requests) + wysyłka e-mail przez GmailApp
 */
function submitPartnerRequest(requestData) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Partner_Requests');

  if (!sheet) {
    sheet = ss.insertSheet('Partner_Requests');
    sheet.appendRow([
      'Request ID', 'Created At', 'Status', 'AM Email',
      'Request Type', 'Partner Name', 'Store Address ID', 'City/Region', 'Comments'
    ]);
  }

  var reqId = 'REQ-' + new Date().getTime();
  var userEmail = Session.getActiveUser().getEmail();
  var createdAt = Utilities.formatDate(new Date(), "GMT+2", "yyyy-MM-dd HH:mm");

  sheet.appendRow([
    reqId,
    createdAt,
    'NEW',
    userEmail,
    requestData.type,
    requestData.partnerName,
    requestData.sfId,
    requestData.region,
    requestData.comments
  ]);

  var subject = "Promo Log 2.0: Nowe zgłoszenie (" + requestData.type + ") - " + requestData.partnerName;
  var body = "Cześć Oliwia,\n\n" +
             "Account Manager " + userEmail + " zgłosił nowe zapotrzebowanie w Promo Log 2.0:\n\n" +
             "• Typ zgłoszenia: " + requestData.type + "\n" +
             "• Partner: " + requestData.partnerName + "\n" +
             "• Store Address ID: " + requestData.sfId + "\n" +
             "• Region: " + requestData.region + "\n" +
             "• Uwagi: " + requestData.comments + "\n\n" +
             "Pozdrawiamy,\nSystem Promo Log 2.0";

  GmailApp.sendEmail("oliwia.korobczyc@glovoapp.com", subject, body);

  return { status: 'SUCCESS', id: reqId };
}

function getPromotionsByStatus(targetStatus) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Master_Log');
  if (!sheet) return [];

  ensureMasterLogHeader_(sheet);

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  var result = [];
  var target = String(targetStatus).trim().toUpperCase();

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var currentStatus = String(row[2]).trim().toUpperCase();

    var isMatch = (target === 'APPROVED')
      ? (currentStatus === 'APPROVED' || currentStatus === 'REJECTED')
      : (currentStatus === target);

    if (isMatch) {
      result.push({
        rowIndex: i + 1,
        id: String(row[0]),
        createdAt: row[1] instanceof Date ? Utilities.formatDate(row[1], "GMT+2", "yyyy-MM-dd HH:mm") : String(row[1]),
        status: String(row[2]),
        budgetSource: String(row[3]),
        partnerName: String(row[4]),
        storeAddressId: String(row[5] || 'ALL'),
        promoPurpose: String(row[6]),
        pitched: String(row[7] || 'Yes'),
        confirmed: String(row[8] || 'Pending'),
        startDate: row[9] instanceof Date ? Utilities.formatDate(row[9], "GMT+2", "yyyy-MM-dd") : String(row[9]),
        endDate: row[10] instanceof Date ? Utilities.formatDate(row[10], "GMT+2", "yyyy-MM-dd") : String(row[10]),
        promoType: String(row[11]),
        promoStrategy: String(row[12]),
        discount: percentToUi_(row[13]),
        bppDiscount: percentToUi_(row[14]),
        products: String(row[15]),
        cofunding: percentToUi_(row[16]),
        uploadWeek: String(row[17] || '-'),
        coverage: percentToUi_(row[18]),
        duration: String(row[19] || '-'),
        segmentation: String(row[20] || '-'),
        maxDiscount: percentToUi_(row[21]),
        matrixKey: String(row[22] || '-'),
        gmvUpliftMultiplier: String(row[23] || '-'),
        ordersUpliftMultiplier: String(row[24] || '-'),
        promoProductsUpliftMultiplier: String(row[25] || '-'),
        promoOrdersPct: percentToUi_(row[26]),
        costIntensity: String(row[27] || '-'),
        baselineGmv: String(row[28] || '-'),
        baselineOrders: String(row[29] || '-'),
        primeShare: percentToUi_(row[30]),
        forecastedGmv: String(row[31] || '-'),
        forecastedOrders: String(row[32] || '-'),
        upliftGmv: String(row[33] || '-'),
        upliftOrders: String(row[34] || '-'),
        incrementalGmv: String(row[35] || '-'),
        incrementalOrders: String(row[36] || '-'),
        estimatedPromoCost: String(row[37] || '-'),
        estimatedBudgetSpend: String(row[38] || '-'),
        am: String(row[39] || ''),
        top3Multiplier: percentToUi_(row[40]),
        uploadPerson: String(row[42] || row[39] || '')
      });
    }
  }
  return result;
}

/**
 * ============================
 * PITCHING OVERVIEW
 * ============================
 *
 * Base = ALL partners from Partners sheet.
 *
 * Promo Purpose is tracked separately for:
 * - Always on
 * - Key Event
 * - Back to University
 * - Prime Week
 * - December BCs campaign
 * - Others
 *
 * A partner is counted only once per purpose, even if there are
 * multiple Master_Log rows for that purpose.
 *
 * getPitchingOverview(promoPurpose):
 * - without purpose -> overall pitching metrics
 * - with purpose -> metrics scoped to that purpose
 * - purposeStats -> always contains all six purposes
 */

var PITCHING_PURPOSES = [
  'Always on',
  'Key Event',
  'Back to University',
  'Prime Week',
  'December BCs campaign',
  'Others'
];


/**
 * Mapping AM email -> team.
 */
function getPitchingTeamMap_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('PROMO_LOG_PITCHING_TEAM_MAP');

  if (cached) {
    return JSON.parse(cached);
  }

  var projectId = 'dhub-glovo';

  var query = `
    SELECT
      LOWER(TRIM(mapping_email)) AS mapping_email,
      TRIM(team) AS team
    FROM \`fulfillment-dwh-production.curated_data_shared_glovo.pl_mapping_table__mapping_pl_v2\`
    WHERE mapping_email IS NOT NULL
      AND TRIM(mapping_email) <> ''
  `;

  var request = BigQuery.newQueryRequest();
  request.query = query;
  request.useLegacySql = false;

  var result = BigQuery.Jobs.query(request, projectId);
  var rows = result.rows || [];

  var map = {};

  rows.forEach(function(r) {
    var email = r.f[0] && r.f[0].v != null
      ? String(r.f[0].v).trim().toLowerCase()
      : '';

    var team = r.f[1] && r.f[1].v != null
      ? String(r.f[1].v).trim()
      : '';

    if (email) {
      map[email] = team || 'Unassigned';
    }
  });

  var json = JSON.stringify(map);

  if (json.length < 95000) {
    cache.put(
      'PROMO_LOG_PITCHING_TEAM_MAP',
      json,
      21600
    );
  }

  return map;
}


/**
 * Converts a value to boolean based on accepted positive values.
 */
function normalizePitchingBool_(value, positiveValues) {
  var v = String(
    value == null ? '' : value
  ).trim().toLowerCase();

  return positiveValues.indexOf(v) !== -1;
}


/**
 * Converts supported Promo Purpose spellings
 * into one canonical value.
 *
 * Unknown / blank values return ''.
 */
function normalizePitchingPurpose_(purpose) {

  var raw = String(
    purpose == null ? '' : purpose
  ).trim();

  if (!raw) {
    return '';
  }

  /*
   * Normalize aggressively:
   * - lowercase
   * - remove spaces
   * - remove punctuation
   * - remove brackets
   */
  var p = raw
    .toLowerCase()
    .replace(/[\(\)\[\]\{\}_\-\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();


  /*
   * ALWAYS ON
   */
  if (
    p === 'always on' ||
    p === 'always-on' ||
    p === 'alwayson'
  ) {
    return 'Always on';
  }


  /*
   * KEY EVENT
   */
  if (
    p === 'key event' ||
    p === 'key events' ||
    p === 'keyevent' ||
    p === 'key_event'
  ) {
    return 'Key Event';
  }


  /*
   * BACK TO UNIVERSITY
   */
  if (
    p === 'back to university' ||
    p === 'back to university campaign' ||
    p === 'back to university btu' ||
    p === 'btu' ||
    p === 'back to university (btu)'
  ) {
    return 'Back to University';
  }


  /*
   * PRIME WEEK (nee "Prime Days" - old rows may still say "Prime Days")
   */
  if (
    p === 'prime week' ||
    p === 'prime weeks' ||
    p === 'primeweek' ||
    p === 'prime_week' ||
    p === 'prime days' ||
    p === 'prime day' ||
    p === 'primedays' ||
    p === 'prime_day'
  ) {
    return 'Prime Week';
  }


  /*
   * DECEMBER BCs
   */
  if (
    p === 'december bcs campaign' ||
    p === 'december bc campaign' ||
    p === 'december bcs' ||
    p === 'december bc' ||
    p === 'decemberbcs'
  ) {
    return 'December BCs campaign';
  }


  /*
   * OTHERS
   */
  if (
    p === 'others' ||
    p === 'other'
  ) {
    return 'Others';
  }


  return '';
}


// A Master_Log "Promo Purpose" cell can hold several purposes, comma
// separated (e.g. "Prime Week, Key Event") since Create Promo allows
// multi-select. These two helpers are how every consumer of that column
// (pitching stats, seasonal trackers, Prime Partners) should read it -
// never compare the raw cell with === any more.
function splitPromoPurposes_(promoPurpose) {
  return String(promoPurpose || '')
    .split(',')
    .map(function(s) { return s.trim(); })
    .filter(Boolean);
}

function promoPurposeIncludes_(promoPurpose, target) {
  var targetNorm = String(target || '').trim().toLowerCase();
  if (!targetNorm) return false;
  return splitPromoPurposes_(promoPurpose).some(function(p) {
    return p.toLowerCase() === targetNorm;
  });
}


/**
 * Creates empty statistics for all Promo Purposes.
 */
function makeEmptyPitchingPurposeStats_() {
  var result = {};
  PITCHING_PURPOSES.forEach(function(purpose) {
    result[purpose] = {
      eligible: true, // Partner z bazy Partners jest domyślnie kwalifikowany do każdego Purpose
      pitched: false,
      confirmed: false,
      cofunding: []
    };
  });
  return result;
}


/**
 * Adds one unique partner to a bucket.
 *
 * IMPORTANT:
 * All purposeStats are aggregated independently.
 *
 * If a purpose is selected:
 * - top-level eligible/pitched/confirmed are filtered
 * - purposeStats still contains ALL purposes
 *
 * This is important for the frontend because the dropdown
 * should be able to switch between purposes without losing
 * the underlying data.
 */
function addPitchingPartner_(
  bucket,
  p,
  selectedPurpose
) {

  /*
   * ---------------------------------------------------------
   * 1. TOP-LEVEL METRICS
   * ---------------------------------------------------------
   */

  if (selectedPurpose) {

    var selected = p.purposeStats[selectedPurpose];

    if (selected && selected.eligible) {
      bucket.eligible++;

      if (selected.pitched) {
        bucket.pitched++;
      }

      if (selected.confirmed) {
        bucket.confirmed++;
      }
    }

  } else {

    bucket.eligible++;

    if (p.pitched) {
      bucket.pitched++;
    }

    if (p.confirmed) {
      bucket.confirmed++;
    }
  }


  /*
   * ---------------------------------------------------------
   * 2. ALL PURPOSE STATS
   * ---------------------------------------------------------
   *
   * These are ALWAYS calculated, regardless of the selected
   * frontend filter.
   */

  PITCHING_PURPOSES.forEach(function(purpose) {

    var stats = p.purposeStats[purpose];

    if (!stats || !stats.eligible) {
      return;
    }

    bucket.purposeStats[purpose].eligible++;

    if (stats.pitched) {
      bucket.purposeStats[purpose].pitched++;
    }

    if (stats.confirmed) {
      bucket.purposeStats[purpose].confirmed++;
    }

    bucket.purposeStats[purpose].cofunding =
      bucket.purposeStats[purpose].cofunding.concat(
        stats.cofunding || []
      );
  });


  /*
   * ---------------------------------------------------------
   * 3. LEGACY KEY EVENT FIELDS
   * ---------------------------------------------------------
   *
   * Kept so the existing frontend does not break.
   */

  var keyEvent =
    p.purposeStats['Key Event'];

  if (keyEvent && keyEvent.eligible) {

    bucket.keyEventEligible++;

    if (keyEvent.pitched) {
      bucket.keyEventPitched++;
    }

    if (keyEvent.confirmed) {
      bucket.keyEventConfirmed++;
    }

    bucket.keyEventCofunding =
      bucket.keyEventCofunding.concat(
        keyEvent.cofunding || []
      );
  }


  /*
   * ---------------------------------------------------------
   * 4. LEGACY ALWAYS ON FIELDS
   * ---------------------------------------------------------
   */

  var alwaysOn =
    p.purposeStats['Always on'];

  if (alwaysOn && alwaysOn.eligible) {

    bucket.alwaysOnEligible++;

    if (alwaysOn.pitched) {
      bucket.alwaysOnPitched++;
    }

    if (alwaysOn.confirmed) {
      bucket.alwaysOnConfirmed++;
    }

    bucket.alwaysOnCofunding =
      bucket.alwaysOnCofunding.concat(
        alwaysOn.cofunding || []
      );
  }
}


/**
 * Finalizes purpose statistics.
 */
function finalizePitchPurposeStats_(purposeStats) {

  var result = {};

  PITCHING_PURPOSES.forEach(function(purpose) {

    var s = purposeStats[purpose] || {
      eligible: 0,
      pitched: 0,
      confirmed: 0,
      cofunding: []
    };

    result[purpose] = {

      eligible: s.eligible,

      pitched: s.pitched,

      pitchRate:
        s.eligible
          ? s.pitched / s.eligible
          : 0,

      confirmed: s.confirmed,

      confirmRate:
        s.pitched
          ? s.confirmed / s.pitched
          : 0,

      avgCofunding:
        averagePitching_(s.cofunding)
    };
  });

  return result;
}


/**
 * Finalizes team / overall bucket.
 */
function finalizePitchingBucket_(b) {

  return {

    team: b.team,

    /*
     * Main selected-purpose metrics
     */
    eligible: b.eligible,

    pitched: b.pitched,

    pitchRate:
      b.eligible
        ? b.pitched / b.eligible
        : 0,

    confirmed: b.confirmed,

    confirmRate:
      b.pitched
        ? b.confirmed / b.pitched
        : 0,


    /*
     * Legacy Key Event fields
     */
    keyEventEligible:
      b.keyEventEligible,

    keyEventPitched:
      b.keyEventPitched,

    keyEventPitchRate:
      b.keyEventEligible
        ? b.keyEventPitched / b.keyEventEligible
        : 0,

    keyEventConfirmed:
      b.keyEventConfirmed,

    keyEventConfirmRate:
      b.keyEventPitched
        ? b.keyEventConfirmed / b.keyEventPitched
        : 0,

    avgKeyEventCofunding:
      averagePitching_(
        b.keyEventCofunding
      ),


    /*
     * Legacy Always On fields
     */
    alwaysOnEligible:
      b.alwaysOnEligible,

    alwaysOnPitched:
      b.alwaysOnPitched,

    alwaysOnPitchRate:
      b.alwaysOnEligible
        ? b.alwaysOnPitched / b.alwaysOnEligible
        : 0,

    alwaysOnConfirmed:
      b.alwaysOnConfirmed,

    alwaysOnConfirmRate:
      b.alwaysOnPitched
        ? b.alwaysOnConfirmed / b.alwaysOnPitched
        : 0,

    avgAlwaysOnCofunding:
      averagePitching_(
        b.alwaysOnCofunding
      ),


    /*
     * NEW:
     * all Promo Purpose statistics
     */
    purposeStats:
      finalizePitchPurposeStats_(
        b.purposeStats
      )
  };
}


/**
 * Creates an empty team bucket.
 */
function makePitchingTeamBucket_(name) {

  return {

    team: name,

    eligible: 0,
    pitched: 0,
    confirmed: 0,

    /*
     * Legacy fields
     */
    keyEventEligible: 0,
    keyEventPitched: 0,
    keyEventConfirmed: 0,

    alwaysOnEligible: 0,
    alwaysOnPitched: 0,
    alwaysOnConfirmed: 0,

    keyEventCofunding: [],
    alwaysOnCofunding: [],

    /*
     * New purpose structure
     */
    purposeStats:
      makeEmptyPitchingPurposeStats_()
  };
}


/**
 * Calculates average cofunding.
 */
function averagePitching_(arr) {

  if (!arr || !arr.length) {
    return 0;
  }

  return arr.reduce(
    function(a, b) {
      return a + b;
    },
    0
  ) / arr.length;
}

var ALLOWED_AM_EMAILS = [
  'sebastian.banaszak@glovoapp.com', 'karolina.wojtowicz@glovoapp.com', 'patrycja.braglewiczkijewska@glovoapp.com',
  'mateusz.glowacki@glovoapp.com', 'yuliia.gabruk@glovoapp.com', 'klaudia.wojtasik@glovoapp.com',
  'monika.kalecinska@glovoapp.com', 'emilia.tarkowska@glovoapp.com', 'kinga.kuzminska@glovoapp.com',
  'sylwia.snieg@glovoapp.com', 'patrycja.pszczolkowska@glovoapp.com', 'sandra.rewerspienkowska@glovoapp.com',
  'karolina.ptaszek@glovoapp.com', 'piotr.jedrysik@glovoapp.com', 'natalia.chuchra@glovoapp.com',
  'daniela.zalewska@glovoapp.com', 'petro.soia@glovoapp.com', 'jan.gola@glovoapp.com',
  'izabela.tomczak@glovoapp.com', 'marcelina.kolodziej@glovoapp.com', 'katarzyna.sekowska@glovoapp.com',
  'lukasz.pluciennik@glovoapp.com', 'mateusz.wojcik@glovoapp.com', 'tomasz.nowak@glovoapp.com',
  'mateusz.puchalski@glovoapp.com', 'lukasz.smolen@glovoapp.com', 'oskar.popielinski@glovoapp.com',
  'hanna.dlutek@glovoapp.com', 'maja.plaskocinska@glovoapp.com', 'brian.mbewe@glovoapp.com',
  'bartosz.bil@glovoapp.com', 'katarzyna.kanigowska@glovoapp.com', 'paulina.jaruminowska@glovoapp.com',
  'daria.jerzewska@glovoapp.com', 'antonina.nowak@glovoapp.com', 'stanislaw.wozniak@glovoapp.com',
  'karolina.stanecka@glovoapp.com','krzysztof.kirejczyk@glovoapp.com','kamila.zygadlo@glovoapp.com','olivia.gawrych@glovoapp.com','marianna.kalebka@glovoapp.com'
];
/**
 * ============================================================
 * MAIN PITCHING OVERVIEW ENDPOINT
 * ============================================================
 *
 * Examples:
 *
 * getPitchingOverview()
 *
 * getPitchingOverview('Prime Week')
 *
 * getPitchingOverview('Key Event')
 *
 * getPitchingOverview('Back to University')
 *
 * getPitchingOverview('December BCs campaign')
 *
 * getPitchingOverview('Others')
 *
 * ============================================================
 */
function getPitchingOverview(promoPurpose) {

  /*
   * ---------------------------------------------------------
   * 1. NORMALIZE SELECTED PURPOSE
   * ---------------------------------------------------------
   */

  var rawPromoPurpose =
    String(
      promoPurpose == null
        ? ''
        : promoPurpose
    ).trim();

  var selectedPurpose =
    normalizePitchingPurpose_(
      rawPromoPurpose
    );


  /*
   * ---------------------------------------------------------
   * 2. LOAD PARTNERS MASTER DATA
   * ---------------------------------------------------------
   */

  var partners =
    getPartnersMasterData_();

  var ss =
    SpreadsheetApp.getActiveSpreadsheet();

  var sheet =
    ss.getSheetByName('Master_Log');

  var data =
    sheet
      ? sheet.getDataRange().getValues()
      : [];


  /*
   * ---------------------------------------------------------
   * 3. BUILD UNIQUE PARTNER MAP
   * ---------------------------------------------------------
   *
   * Partners sheet is the source of eligibility.
   */

  var partnerMap = {};


  partners.forEach(function(p) {

    var name =
      String(
        p.storeName || ''
      ).trim();

    if (!name) {
      return;
    }

    var key =
      normalizeName_(name);

    if (!key) {
      return;
    }


    var am =
      String(
        p.accountManager || ''
      ).trim();

    var teamGroup =
      String(
        p.teamGroup || ''
      ).trim();

    var teamName =
      String(
        p.team || ''
      ).trim();


    /*
     * Partners mapping:
     *
     * Team Group = Regions
     * -> use the actual Region from Team
     *
     * Big Chain / SMB
     * -> use Team Group
     */

    var team;

    if (
      teamGroup.toLowerCase() ===
      'regions'
    ) {

      team = teamName;

    } else {

      team =
        teamGroup ||
        teamName;
    }


    /*
     * Don't show unassigned partners
     * in the pitching team view.
     */

    if (
      !team ||
      team.toLowerCase() ===
      'unassigned'
    ) {
      return;
    }


    partnerMap[key] = {

      partnerName: name,

      accountManager: am,

      team: team,

      /*
       * Overall activity
       */
      eligible: true,

      pitched: false,

      confirmed: false,


      /*
       * Purpose-specific activity
       */
      purposeStats:
        makeEmptyPitchingPurposeStats_(),


      /*
       * Legacy fields
       */
      keyEventPitched: false,
      keyEventConfirmed: false,

      alwaysOnPitched: false,
      alwaysOnConfirmed: false,

      keyEventCofunding: [],
      alwaysOnCofunding: []
    };
  });


  /*
   * ---------------------------------------------------------
   * 4. READ MASTER LOG
   * ---------------------------------------------------------
   *
   * Master_Log columns:
   *
   * E = Partner Name       -> row[4]
   * G = Promo Purpose      -> row[6]
   * H = Pitched            -> row[7]
   * I = Confirmed          -> row[8]
   * Q = Co-funding         -> row[16]
   */

  for (
    var i = 1;
    i < data.length;
    i++
  ) {

    var row = data[i];

    var name =
      String(
        row[4] == null
          ? ''
          : row[4]
      ).trim();

    var key =
      normalizeName_(name);

    if (
      !key ||
      !partnerMap[key]
    ) {
      continue;
    }

    var p =
      partnerMap[key];


    /*
     * Promo Purpose - a row can now carry several, comma-separated
     * (e.g. "Prime Week, Key Event"). Each one gets its own stats bucket.
     */
    var purposeList =
      splitPromoPurposes_(row[6])
        .map(normalizePitchingPurpose_)
        .filter(Boolean);

    purposeList = purposeList.filter(function(v, idx) {
      return purposeList.indexOf(v) === idx;
    });


    /*
     * Pitched
     */
    var pitched =
      normalizePitchingBool_(
        row[7],
        [
          'yes',
          'y',
          'true',
          '1'
        ]
      );


    /*
     * Confirmed
     */
    var confirmed =
      normalizePitchingBool_(
        row[8],
        [
          'yes',
          'y',
          'true',
          '1',
          'confirmed'
        ]
      );


    /*
     * Co-funding
     */
    var cof =
      toNumber_(row[16]);


    /*
     * -------------------------------------------------------
     * OVERALL PARTNER STATUS
     * -------------------------------------------------------
     *
     * One partner counts only once.
     */

    if (pitched) {
      p.pitched = true;
    }

    if (confirmed) {
      p.confirmed = true;
    }


    /*
     * -------------------------------------------------------
     * PURPOSE STATUS
     * -------------------------------------------------------
     */

    if (!purposeList.length) {
      continue;
    }

    purposeList.forEach(function(purpose) {

      var stats =
        p.purposeStats[purpose];

      if (pitched) {
        stats.pitched = true;
      }

      if (confirmed) {
        stats.confirmed = true;
      }


      if (
        isFinite(cof) &&
        cof >= 0
      ) {

        stats.cofunding.push(cof);
      }
    });
  }


  /*
   * ---------------------------------------------------------
   * 5. TEAM ORDER
   * ---------------------------------------------------------
   */

  var teamOrder = [
    'Big Chain',
    'North',
    'South',
    'East',
    'SMB'
  ];


  /*
   * ---------------------------------------------------------
   * 6. CREATE TEAM BUCKETS
   * ---------------------------------------------------------
   */

  var teams = {};

  teamOrder.forEach(
    function(teamName) {

      teams[teamName] =
        makePitchingTeamBucket_(
          teamName
        );
    }
  );


  /*
   * Overall bucket
   */

  var overall =
    makePitchingTeamBucket_(
      'Overall'
    );


  /*
   * Account Managers
   */

  var ams = {};


  /*
   * ---------------------------------------------------------
   * 7. AGGREGATE PARTNERS
   * ---------------------------------------------------------
   */

  Object.keys(
    partnerMap
  ).forEach(function(key) {

    var p =
      partnerMap[key];


    /*
     * Find team bucket.
     */

    var team =
      teams[p.team]
        ? p.team
        : null;

    if (!team) {
      return;
    }


    /*
     * Team
     */

    addPitchingPartner_(
      teams[team],
      p,
      selectedPurpose
    );


    /*
     * Overall
     */

    addPitchingPartner_(
      overall,
      p,
      selectedPurpose
    );


    /*
     * -------------------------------------------------------
     * ACCOUNT MANAGER
     * -------------------------------------------------------
     */

    var amKey =
      p.accountManager ||
      'Unassigned';

    var amMapKey =
      amKey.toLowerCase();


    if (!ams[amMapKey]) {

      ams[amMapKey] = {

        accountManager:
          amKey,

        team:
          team,


        /*
         * Top-level metrics
         */
        eligible: 0,
        pitched: 0,
        confirmed: 0,


        /*
         * Legacy fields
         */
        keyEventEligible: 0,
        keyEventPitched: 0,
        keyEventConfirmed: 0,

        alwaysOnEligible: 0,
        alwaysOnPitched: 0,
        alwaysOnConfirmed: 0,

        keyEventCofunding: [],
        alwaysOnCofunding: [],


        /*
         * All purpose stats
         */
        purposeStats:
          makeEmptyPitchingPurposeStats_()
      };
    }


    var a =
      ams[amMapKey];


    /*
     * -------------------------------------------------------
     * AM TOP-LEVEL METRICS
     * -------------------------------------------------------
     */

    if (selectedPurpose) {

      var selected =
        p.purposeStats[
          selectedPurpose
        ];

      if (
        selected &&
        selected.eligible
      ) {

        a.eligible++;

        if (selected.pitched) {
          a.pitched++;
        }

        if (selected.confirmed) {
          a.confirmed++;
        }
      }

    } else {

      a.eligible++;

      if (p.pitched) {
        a.pitched++;
      }

      if (p.confirmed) {
        a.confirmed++;
      }
    }


    /*
     * -------------------------------------------------------
     * AM ALL PURPOSE STATS
     * -------------------------------------------------------
     *
     * IMPORTANT:
     * These are calculated even when a purpose filter
     * is active.
     */

    PITCHING_PURPOSES.forEach(
      function(purpose) {

        var stats =
          p.purposeStats[purpose];

        if (
          !stats ||
          !stats.eligible
        ) {
          return;
        }


        a.purposeStats[purpose]
          .eligible++;


        if (stats.pitched) {

          a.purposeStats[purpose]
            .pitched++;
        }


        if (stats.confirmed) {

          a.purposeStats[purpose]
            .confirmed++;
        }


        a.purposeStats[purpose]
          .cofunding =
          a.purposeStats[purpose]
            .cofunding
            .concat(
              stats.cofunding || []
            );
      }
    );


    /*
     * -------------------------------------------------------
     * AM LEGACY KEY EVENT
     * -------------------------------------------------------
     */

    var amKeyEvent =
      p.purposeStats[
        'Key Event'
      ];

    if (
      amKeyEvent &&
      amKeyEvent.eligible
    ) {

      a.keyEventEligible++;

      if (amKeyEvent.pitched) {
        a.keyEventPitched++;
      }

      if (amKeyEvent.confirmed) {
        a.keyEventConfirmed++;
      }

      a.keyEventCofunding =
        a.keyEventCofunding.concat(
          amKeyEvent.cofunding || []
        );
    }


    /*
     * -------------------------------------------------------
     * AM LEGACY ALWAYS ON
     * -------------------------------------------------------
     */

    var amAlwaysOn =
      p.purposeStats[
        'Always on'
      ];

    if (
      amAlwaysOn &&
      amAlwaysOn.eligible
    ) {

      a.alwaysOnEligible++;

      if (amAlwaysOn.pitched) {
        a.alwaysOnPitched++;
      }

      if (amAlwaysOn.confirmed) {
        a.alwaysOnConfirmed++;
      }

      a.alwaysOnCofunding =
        a.alwaysOnCofunding.concat(
          amAlwaysOn.cofunding || []
        );
    }
  });


  /*
   * ---------------------------------------------------------
   * 8. FINALIZE TEAM BUCKETS
   * ---------------------------------------------------------
   */

  Object.keys(
    teams
  ).forEach(function(teamName) {

    teams[teamName] =
      finalizePitchingBucket_(
        teams[teamName]
      );
  });


  /*
   * ---------------------------------------------------------
   * 9. FINALIZE OVERALL
   * ---------------------------------------------------------
   */

  overall =
    finalizePitchingBucket_(
      overall
    );


  /*
   * ---------------------------------------------------------
   * 10. FINALIZE AM LIST
   * ---------------------------------------------------------
   */

  var amList =
    Object.keys(ams)
      .filter(function(key) {
        // Zwracamy tylko AMów z dozwolonej listy
        return ALLOWED_AM_EMAILS.indexOf(key.toLowerCase()) !== -1;
      })
      .map(function(key) {
        var a = ams[key];

        a.pitchRate = a.eligible ? a.pitched / a.eligible : 0;
        a.confirmRate = a.pitched ? a.confirmed / a.pitched : 0;

        a.keyEventPitchRate = a.keyEventEligible ? a.keyEventPitched / a.keyEventEligible : 0;
        a.keyEventConfirmRate = a.keyEventPitched ? a.keyEventConfirmed / a.keyEventPitched : 0;

        a.alwaysOnPitchRate = a.alwaysOnEligible ? a.alwaysOnPitched / a.alwaysOnEligible : 0;
        a.alwaysOnConfirmRate = a.alwaysOnPitched ? a.alwaysOnConfirmed / a.alwaysOnPitched : 0;

        a.avgKeyEventCofunding = averagePitching_(a.keyEventCofunding);
        a.avgAlwaysOnCofunding = averagePitching_(a.alwaysOnCofunding);

        a.purposeStats = finalizePitchPurposeStats_(a.purposeStats);

        return a;
      });


  /*
   * ---------------------------------------------------------
   * 11. SORT AMs
   * ---------------------------------------------------------
   */

  amList.sort(
    function(a, b) {

      return (
        teamOrder.indexOf(a.team) -
        teamOrder.indexOf(b.team)
      ) || a.accountManager
        .localeCompare(
          b.accountManager
        );
    }
  );


/*
   * ---------------------------------------------------------
   * 12. CALCULATE TOP 3 OVERVIEW (OGÓŁEM + TEAMS)
   * ---------------------------------------------------------
   */
  var top3List = getTop3PartnersMaster_();
  var top3PartnersCount = 0;
  var top3Overall = makePitchingTeamBucket_('Top 3 Overall');

  var top3Teams = {};
  teamOrder.forEach(function(teamName) {
    top3Teams[teamName] = makePitchingTeamBucket_(teamName);
  });

  Object.keys(partnerMap).forEach(function(key) {
    if (top3List.indexOf(key) !== -1) {
      top3PartnersCount++;
      var p = partnerMap[key];

      addPitchingPartner_(top3Overall, p, selectedPurpose);

      if (top3Teams[p.team]) {
        addPitchingPartner_(top3Teams[p.team], p, selectedPurpose);
      }
    }
  });

  top3Overall = finalizePitchingBucket_(top3Overall);

  var top3TeamsList = teamOrder.map(function(teamName) {
    return finalizePitchingBucket_(top3Teams[teamName]);
  });

  /*
   * ---------------------------------------------------------
   * 13. FINAL RESPONSE
   * ---------------------------------------------------------
   */
  return {
    generatedAt: new Date().toISOString(),
    selectedPurpose: selectedPurpose,
    promoPurposes: PITCHING_PURPOSES.slice(),
    totalPartners: partners.length,
    overall: overall,
    teams: teamOrder.map(function(teamName) { return teams[teamName]; }),
    accountManagers: amList,
    top3Overview: {
      totalEligible: top3PartnersCount,
      overall: top3Overall,
      teams: top3TeamsList
    }
  };
}

/**
 * ============================
 * BACK TO UNIVERSITY TRACKER
 * ============================
 * Source of initial tracker partners: BTU sheet (A:C).
 * Additional partners can be added from the web app.
 * Partner -> AM / Team comes from Partners J:L.
 */
function ensureBTUHeader_(sheet) {
  var headers = [
    'City',
    'Store Name',
    'Store ID',
    'GMV Weight',
    'Account Manager',
    'Team',
    'On promo?',
    '>=30% OFF Promo or 2X1?',
    '>=10% OFF Prime?',
    '>=5% OFF Prime?',
    'Linked Promo ID',
    'Last Updated',
    'Source',
    '>=20% OFF Promo?'
  ];

  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
}

/**
 * ONE-TIME MIGRATION.
 *
 * The ">=5% OFF Prime?" column was inserted in the middle of the existing
 * BTU layout (between ">=10% OFF Prime?" and "Linked Promo ID"). Run this
 * once from the Apps Script editor (select this function, click Run) before
 * anyone opens the Back to University tab, so existing "Linked Promo ID" /
 * "Last Updated" / "Source" data shifts along with the new column instead
 * of being silently misread from the wrong column.
 *
 * Safe to run more than once: it no-ops once the sheet is already on the
 * new layout.
 */
function migrateBTUInsertPrime5Column() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('BTU');
  if (!sheet || sheet.getLastRow() < 1) {
    return { status: 'SKIPPED', reason: 'BTU sheet not found or empty.' };
  }

  var currentHeaderJ = String(sheet.getRange(1, 10).getValue() || '').trim();

  if (currentHeaderJ === '>=5% OFF Prime?') {
    return { status: 'SKIPPED', reason: 'Already migrated.' };
  }

  sheet.insertColumnBefore(10);
  ensureBTUHeader_(sheet);

  return { status: 'SUCCESS' };
}

function normalizeBTUName_(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

function getBTUAmMetaMap_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('AM<>Manager mapping');
  var map = {};
  if (!sheet || sheet.getLastRow() < 2) return map;
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  values.forEach(function(r) {
    var email = String(r[0] || '').trim().toLowerCase();
    var manager = String(r[1] || '').trim();
    if (email) map[email] = manager;
  });
  return map;
}

function getBTUAmTeamMap_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Partners');
  var map = {};
  if (!sheet || sheet.getLastRow() < 2) return map;
  var values = sheet.getRange(2, 10, sheet.getLastRow() - 1, 3).getValues(); // J:L
  values.forEach(function(r) {
    var email = String(r[0] || '').trim().toLowerCase();
    if (!email) return;
    map[email] = {
      team: String(r[1] || '').trim(),
      teamGroup: String(r[2] || '').trim()
    };
  });
  return map;
}

// Which trackers exist: sheet name -> Master_Log "Promo Purpose" value they
// match promos against. Add a new entry here (and nowhere else) to wire up
// a future seasonal tracker the same way BTU and Christmas work.
var TRACKER_DEFINITIONS = {
  'BTU': { promoPurpose: 'back to university' },
  'Christmas': { promoPurpose: 'get ready for christmas' }
};

function getBTUTracker() {
  return getTracker_('BTU');
}

function getChristmasTracker() {
  return getTracker_('Christmas');
}

function getTracker_(sheetName) {
  var def = TRACKER_DEFINITIONS[sheetName];
  if (!def) throw new Error('Unknown tracker: ' + sheetName);
  var promoPurpose = def.promoPurpose;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);

  Logger.log('BTU DEBUG 0 - function started');
  Logger.log('BTU DEBUG 0a - spreadsheet: ' + ss.getName());
  Logger.log('BTU DEBUG 0b - sheet found: ' + !!sheet);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    Logger.log('BTU DEBUG 0c - ' + sheetName + ' sheet was missing, created new sheet');
  }

  ensureBTUHeader_(sheet);
  Logger.log('BTU DEBUG 0d - header checked');

  var lastRow = sheet.getLastRow();
  Logger.log('BTU DEBUG 0e - lastRow: ' + lastRow);

  if (lastRow < 2) {
    Logger.log('BTU DEBUG STOP - no data rows');
    return {
      rows: [],
      summary: makeBTUSummary_([])
    };
  }

  // ---------------------------------------------------------
  // 1. READ BTU SHEET
  // ---------------------------------------------------------

  var values = sheet.getRange(2, 1, lastRow - 1, 14).getValues();

  Logger.log('BTU DEBUG 1 - values rows: ' + values.length);
  Logger.log('BTU DEBUG 1a - first raw row: ' + JSON.stringify(values[0]));

  // ---------------------------------------------------------
  // 2. LOAD PARTNERS MASTER DATA
  // ---------------------------------------------------------

  var partners = getPartnersMasterData_();

  Logger.log('BTU DEBUG 2 - partners loaded: ' + partners.length);

  var partnerMap = {};

  partners.forEach(function(p) {
    partnerMap[normalizeBTUName_(p.storeName)] = p;
  });

  Logger.log(
    'BTU DEBUG 2a - partnerMap keys: ' +
    Object.keys(partnerMap).length
  );

  // ---------------------------------------------------------
  // 3. LOAD AM / MANAGER / TEAM DATA
  // ---------------------------------------------------------

  var managerMap = getBTUAmMetaMap_();

  Logger.log(
    'BTU DEBUG 3 - managerMap keys: ' +
    Object.keys(managerMap).length
  );

  var amTeamMap = getBTUAmTeamMap_();

  Logger.log(
    'BTU DEBUG 4 - amTeamMap keys: ' +
    Object.keys(amTeamMap).length
  );

  // ---------------------------------------------------------
  // 4. READ MASTER LOG
  // ---------------------------------------------------------

  var master = ss.getSheetByName('Master_Log');

  Logger.log(
    'BTU DEBUG 4a - Master_Log found: ' +
    !!master
  );

  var masterValues = master && master.getLastRow() >= 2
    ? master.getRange(
        2,
        1,
        master.getLastRow() - 1,
        41
      ).getValues()
    : [];

  Logger.log(
    'BTU DEBUG 4b - Master_Log rows: ' +
    masterValues.length
  );

  // ---------------------------------------------------------
  // 5. BUILD BTU PROMO MAP
  // ---------------------------------------------------------

  var btuPromoMap = {};

  masterValues.forEach(function(r) {
    var name = normalizeBTUName_(r[4]);

    var purpose = String(
      r[6] == null ? '' : r[6]
    ).trim().toLowerCase();

    if (!name || purpose !== promoPurpose) return;

    var status = String(
      r[2] == null ? '' : r[2]
    ).trim().toUpperCase();

    if (status === 'REJECTED') return;

    if (!btuPromoMap[name]) {
      btuPromoMap[name] = [];
    }

    btuPromoMap[name].push({
      id: String(r[0] || ''),
      status: status,
      strategy: String(r[12] || '').trim(),
      maxDiscount: r[21],
      bppDiscount: r[14],
      standardDiscount: r[13]
    });
  });

  Logger.log(
    'BTU DEBUG 5 - btuPromoMap keys: ' +
    Object.keys(btuPromoMap).length
  );

  // ---------------------------------------------------------
  // 6. CREATE TRACKER ROWS
  // ---------------------------------------------------------

  Logger.log('BTU DEBUG 6 - starting values.map()');

  var rows = values.map(function(r, idx) {

    var name = String(r[1] || '').trim();
    var key = normalizeBTUName_(name);
    var partner = partnerMap[key] || {};

    // IMPORTANT:
    // BTU AM is editable and therefore the value stored in BTU!E
    // is the source of truth for this tracker.
    // Only fall back to Partners when the BTU cell is empty.

    var accountManager = String(
      r[4] || partner.accountManager || ''
    ).trim();

    var amKey = accountManager.toLowerCase();

    var teamMeta = amTeamMap[amKey] || {};

    var team = String(
      r[5] ||
      teamMeta.team ||
      partner.team ||
      ''
    ).trim();

    var manager = managerMap[amKey] || '';

    var promos = btuPromoMap[key] || [];

    var onPromo = promos.length > 0
      ? 'Yes'
      : String(r[6] || '');

    var linkedId = promos.length
      ? promos[promos.length - 1].id
      : String(r[10] || '');

    return {
      rowIndex: idx + 2,
      city: String(r[0] || ''),
      storeName: name,
      storeId: String(r[2] || ''),
      gmvWeight: r[3] === '' ? '' : toNumber_(r[3]),
      accountManager: accountManager,
      team: team,
      manager: manager,
      onPromo: onPromo,
      highDiscount: String(r[7] || ''),
      prime10: String(r[8] || ''),
      prime5: String(r[9] || ''),
      linkedPromoId: linkedId,
      lastUpdated: r[11] instanceof Date
        ? r[11].toISOString()
        : String(r[11] || ''),
      source: String(r[12] || 'Initial list'),
      // GRFC-specific second discount tier (Top Sellers, wk48-49): >=20% OFF.
      // Appended as column N so BTU's existing A-M layout never had to shift.
      highDiscount20: String(r[13] || '')
    };
  });

  Logger.log(
    'BTU DEBUG 7 - rows created: ' +
    rows.length
  );

  Logger.log(
    'BTU DEBUG 7a - first mapped row: ' +
    JSON.stringify(rows[0])
  );

  Logger.log(
    'BTU DEBUG 7b - last mapped row: ' +
    JSON.stringify(rows[rows.length - 1])
  );

  // ---------------------------------------------------------
  // 8. BUILD SUMMARY
  // ---------------------------------------------------------

  Logger.log('BTU DEBUG 8 - starting makeBTUSummary_()');

  var summary = makeBTUSummary_(rows);

  Logger.log(
    'BTU DEBUG 8a - summary total: ' +
    summary.total
  );

  Logger.log(
    'BTU DEBUG 8b - summary cities: ' +
    (summary.cities ? summary.cities.length : 'NO CITIES')
  );

  // ---------------------------------------------------------
  // 9. RETURN TO FRONTEND
  // ---------------------------------------------------------

  Logger.log('BTU DEBUG 9 - preparing final return');

  var result = {
    generatedAt: new Date().toISOString(),
    rows: rows,
    summary: summary
  };

  Logger.log(
    'BTU DEBUG 9a - final rows: ' +
    result.rows.length
  );

  Logger.log(
    'BTU DEBUG 9b - final result exists: ' +
    !!result
  );

  Logger.log('BTU DEBUG 10 - RETURNING RESULT');

  return result;
}

function makeBTUSummary_(rows) {
  // Legacy BTU summary is GMV-weight based. BTU!D already contains the
  // store/city GMV weight imported from the legacy gmv data, so we do not
  // need to query the old gmv source again.
  var cities = {};
  rows.forEach(function(r) {
    var city = String(r.city || 'Other').trim() || 'Other';
    if (!cities[city]) {
      cities[city] = {
        city: city,
        totalWeight: 0,
        promoWeight: 0,
        highDiscountWeight: 0,
        highDiscount20Weight: 0,
        bppWeight: 0,
        prime5Weight: 0,
        total: 0,
        onPromo: 0,
        highDiscount: 0,
        highDiscount20: 0,
        prime10: 0,
        prime5: 0
      };
    }
    var c = cities[city];
    var w = Number(r.gmvWeight) || 0;
    c.totalWeight += w;
    c.total++;

    var onPromo = String(r.onPromo || '').trim().toLowerCase() === 'yes';
    var high = String(r.highDiscount || '').trim().toLowerCase() === 'yes';
    var high20 = String(r.highDiscount20 || '').trim().toLowerCase() === 'yes';
    var prime = String(r.prime10 || '').trim().toLowerCase() === 'yes';
    var prime5 = String(r.prime5 || '').trim().toLowerCase() === 'yes';

    if (onPromo) { c.onPromo++; c.promoWeight += w; }
    if (high) { c.highDiscount++; c.highDiscountWeight += w; }
    if (high20) { c.highDiscount20++; c.highDiscount20Weight += w; }
    if (prime) { c.prime10++; }
    if (prime5) { c.prime5++; c.prime5Weight += w; }

    // BPP/Prime is represented by the tracker Prime flag for the BTU view.
    if (prime) c.bppWeight += w;
  });

  var list = Object.keys(cities).map(function(k) {
    var c = cities[k];
    // GMV Weight (BTU!D) is already each store's share of its CITY's total
    // GMV (backfilled from "gmv data" -> store_share_of_city_gmv). So
    // c.promoWeight etc. are already expressed against the real city GMV -
    // dividing by c.totalWeight (the sum of weights of tracker rows ONLY)
    // would re-scale them against a partial, tracker-only denominator and
    // inflate every rate. Use the weights directly.
    return {
      city: c.city,
      total: c.total,
      totalWeight: c.totalWeight,
      onPromo: c.onPromo,
      highDiscount: c.highDiscount,
      highDiscount20: c.highDiscount20,
      prime10: c.prime10,
      prime5: c.prime5,
      promoRate: c.promoWeight,
      highDiscountRate: c.highDiscountWeight,
      highDiscount20Rate: c.highDiscount20Weight,
      bppRate: c.bppWeight,
      prime5Rate: c.prime5Weight,
      // Keep the legacy naming for the UI.
      springPromoRate: c.totalWeight,
      promoGmvRate: c.promoWeight
    };
  });

  list = list.filter(function(c) { return c.city.toLowerCase() !== 'other'; });

  // Top cities always lead the list, in this fixed order; everything else
  // follows sorted by % GMV descending, same as before.
  var BTU_TOP_CITIES = ['WAW', 'KRA', 'GDN', 'LOD', 'POZ', 'WRO'];
  list.sort(function(a, b) {
    var aTop = BTU_TOP_CITIES.indexOf(a.city);
    var bTop = BTU_TOP_CITIES.indexOf(b.city);
    if (aTop !== -1 || bTop !== -1) {
      if (aTop === -1) return 1;
      if (bTop === -1) return -1;
      return aTop - bTop;
    }
    return b.totalWeight - a.totalWeight || a.city.localeCompare(b.city);
  });

  var total = rows.length;
  var totalWeight = rows.reduce(function(sum, r) { return sum + (Number(r.gmvWeight) || 0); }, 0);
  var onPromo = rows.filter(function(r){ return String(r.onPromo).toLowerCase() === 'yes'; });
  var highDiscount = rows.filter(function(r){ return String(r.highDiscount).toLowerCase() === 'yes'; });
  var highDiscount20 = rows.filter(function(r){ return String(r.highDiscount20).toLowerCase() === 'yes'; });
  var prime10 = rows.filter(function(r){ return String(r.prime10).toLowerCase() === 'yes'; });
  var prime5 = rows.filter(function(r){ return String(r.prime5).toLowerCase() === 'yes'; });

  return {
    total: total,
    totalWeight: totalWeight,
    onPromo: onPromo.length,
    highDiscount: highDiscount.length,
    highDiscount20: highDiscount20.length,
    prime10: prime10.length,
    prime5: prime5.length,
    promoRate: total ? onPromo.length / total : 0,
    cities: list
  };
}

function saveBTUTrackerRow(rowData) {
  return saveTrackerRow_('BTU', rowData);
}
function saveChristmasTrackerRow(rowData) {
  return saveTrackerRow_('Christmas', rowData);
}

// Batch version: saves every dirty row in one call so the UI only ever
// needs a single "Save All" round trip, instead of one per edited row.
function saveTrackerRowsBulk(sheetName, rowsData) {
  var results = (rowsData || []).map(function(rowData) {
    try {
      return saveTrackerRow_(sheetName, rowData);
    } catch (e) {
      return { status: 'ERROR', rowIndex: rowData.rowIndex, message: e.message };
    }
  });
  var failed = results.filter(function(r) { return r.status === 'ERROR'; });
  return { status: failed.length ? 'PARTIAL' : 'SUCCESS', results: results, failedCount: failed.length };
}

function saveTrackerRow_(sheetName, rowData) {
  if (!TRACKER_DEFINITIONS[sheetName]) throw new Error('Unknown tracker: ' + sheetName);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Nie znaleziono arkusza ' + sheetName + '.');
  ensureBTUHeader_(sheet);

  var rowIndex = Number(rowData.rowIndex);
  if (!rowIndex || rowIndex < 2 || rowIndex > sheet.getLastRow()) {
    throw new Error('Nieprawidłowy numer wiersza ' + sheetName + '.');
  }

  var accountManager = String(rowData.accountManager || '').trim();
  var amKey = accountManager.toLowerCase();
  var amTeamMap = getBTUAmTeamMap_();
  var managerMap = getBTUAmMetaMap_();
  var teamMeta = amTeamMap[amKey] || {};
  var team = String(teamMeta.team || rowData.team || '').trim();

  sheet.getRange(rowIndex, 1, 1, 14).setValues([[
    rowData.city || '',
    rowData.storeName || '',
    rowData.storeId || '',
    rowData.gmvWeight === '' || rowData.gmvWeight == null ? '' : toNumber_(rowData.gmvWeight),
    accountManager,
    team,
    rowData.onPromo || '',
    rowData.highDiscount || '',
    rowData.prime10 || '',
    rowData.prime5 || '',
    rowData.linkedPromoId || '',
    new Date(),
    rowData.source || 'Manual',
    rowData.highDiscount20 || ''
  ]]);

  return { status: 'SUCCESS', rowIndex: rowIndex, accountManager: accountManager, team: team, manager: managerMap[amKey] || '' };
}

function addBTUPartner(rowData) {
  return addTrackerPartner_('BTU', rowData);
}
function addChristmasPartner(rowData) {
  return addTrackerPartner_('Christmas', rowData);
}

// Batch version: adds several partners (e.g. pasted from a spreadsheet) in
// one call instead of one modal submission per partner.
function addTrackerPartnersBulk(sheetName, rowsData) {
  var results = (rowsData || []).map(function(rowData) {
    try {
      return addTrackerPartner_(sheetName, rowData);
    } catch (e) {
      return { status: 'ERROR', storeName: rowData.storeName, message: e.message };
    }
  });
  var added = results.filter(function(r) { return r.status === 'SUCCESS'; });
  var skipped = results.filter(function(r) { return r.status === 'EXISTS'; });
  var failed = results.filter(function(r) { return r.status === 'ERROR'; });
  return { status: 'SUCCESS', results: results, addedCount: added.length, skippedCount: skipped.length, failedCount: failed.length };
}

function addTrackerPartner_(sheetName, rowData) {
  if (!TRACKER_DEFINITIONS[sheetName]) throw new Error('Unknown tracker: ' + sheetName);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  ensureBTUHeader_(sheet);

  var name = String(rowData.storeName || '').trim();
  if (!name) throw new Error('Podaj nazwę partnera.');

  var existing = getTracker_(sheetName).rows;
  var key = normalizeBTUName_(name);
  var duplicate = existing.find(function(r) { return normalizeBTUName_(r.storeName) === key; });
  if (duplicate) return { status: 'EXISTS', rowIndex: duplicate.rowIndex, storeName: name };

  var partners = getPartnersMasterData_();
  var partner = partners.find(function(p) { return normalizeBTUName_(p.storeName) === key; });
  var am = String(rowData.accountManager || (partner ? partner.accountManager : '') || '').trim();
  var teamMeta = getBTUAmTeamMap_()[am.toLowerCase()] || {};

  var row = [
    rowData.city || '',
    name,
    rowData.storeId || '',
    rowData.gmvWeight === '' || rowData.gmvWeight == null ? '' : toNumber_(rowData.gmvWeight),
    am,
    teamMeta.team || (partner ? (partner.team || '') : ''),
    rowData.onPromo || 'No',
    rowData.highDiscount || '',
    rowData.prime10 || '',
    rowData.prime5 || '',
    '',
    new Date(),
    'Manual',
    rowData.highDiscount20 || ''
  ];

  sheet.appendRow(row);
  return { status: 'SUCCESS', rowIndex: sheet.getLastRow(), storeName: name };
}

/**
 * Total-Poland "% GMV in Promo" for a seasonal tracker (BTU or Christmas).
 *
 * Unlike the per-city Summary table (which is scoped to GMV of partners
 * already sitting in the tracker - see makeBTUSummary_), this is weighted
 * against the REAL total GMV of the whole country, pulled live from
 * BigQuery into the "National_GMV" sheet by Data_Pull.gs's
 * refreshNationalGmv() (run weekly, or manually when fresher data is
 * needed). A partner counts as "covered" if either:
 *   - it's in the tracker with "On promo? = Yes", or
 *   - it has an APPROVED Master_Log promo whose Promo Purpose matches this
 *     tracker (resolved by Store Address ID when filled in, otherwise by
 *     partner name via the Partners sheet's store_id list - a lot of
 *     Master_Log rows don't have Store Address ID filled in).
 */
function getTrackerNationalGmvCoverage(sheetName) {
  var def = TRACKER_DEFINITIONS[sheetName];
  if (!def) throw new Error('Unknown tracker: ' + sheetName);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var gmvSheet = ss.getSheetByName(DATA_PULL_NATIONAL_GMV_SHEET);
  if (!gmvSheet || gmvSheet.getLastRow() < 2) {
    return { generatedAt: null, pctGmvCovered: 0, coveredGmv: 0, totalGmv: 0, pctGmvCoveredTop6: 0, cities: [] };
  }

  // National_GMV columns: store_id, store_address_id, city_code, avg_daily_gmv
  var gmvRows = gmvSheet.getRange(2, 1, gmvSheet.getLastRow() - 1, 4).getValues();

  // Cities shown in the per-city breakdown: our 6 priority cities + KTW.
  var SUMMARY_CITIES = ['WAW', 'KRA', 'GDN', 'LOD', 'POZ', 'WRO', 'KTW'];

  // 1. Covered store_id + tracker partner counts per city (On promo? = Yes
  //    only counts toward "covered" GMV; the partner count itself is every
  //    row in the tracker for that city, regardless of status).
  var coveredStoreIds = {};
  var cityPartnerCounts = {};
  var trackerSheet = ss.getSheetByName(sheetName);
  if (trackerSheet && trackerSheet.getLastRow() >= 2) {
    var trackerRows = trackerSheet.getRange(2, 1, trackerSheet.getLastRow() - 1, 7).getValues();
    trackerRows.forEach(function(r) {
      var city = String(r[0] || '').trim().toUpperCase();
      var storeId = String(r[2] || '').trim();
      var onPromo = String(r[6] || '').trim().toLowerCase();
      if (city) cityPartnerCounts[city] = (cityPartnerCounts[city] || 0) + 1;
      if (storeId && onPromo === 'yes') coveredStoreIds[storeId] = true;
    });
  }

  // 2. Name -> store_id list, for Master_Log rows with no Store Address ID.
  var nameToStoreIds = {};
  var partnersSheet = ss.getSheetByName(PARTNERS_REFERENCE_SHEET);
  if (partnersSheet && partnersSheet.getLastRow() >= 2) {
    var pRows = partnersSheet.getRange(2, 1, partnersSheet.getLastRow() - 1, 13).getValues();
    pRows.forEach(function(r) {
      var key = normalizeBTUName_(r[0]);
      var ids = String(r[12] || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
      if (key && ids.length) nameToStoreIds[key] = ids;
    });
  }

  // 3. Covered Master_Log rows (APPROVED, matching this tracker's Promo Purpose).
  var coveredAddrIds = {};
  var master = ss.getSheetByName('Master_Log');
  if (master && master.getLastRow() >= 2) {
    var masterRows = master.getRange(2, 1, master.getLastRow() - 1, 7).getValues();
    masterRows.forEach(function(r) {
      var status = String(r[2] || '').trim().toUpperCase();
      if (status !== 'APPROVED' || !promoPurposeIncludes_(r[6], def.promoPurpose)) return;
      var addrId = String(r[5] || '').trim();
      if (addrId) {
        coveredAddrIds[addrId] = true;
      } else {
        var nameKey = normalizeBTUName_(r[4]);
        (nameToStoreIds[nameKey] || []).forEach(function(id) { coveredStoreIds[id] = true; });
      }
    });
  }

  var totalGmv = 0;
  var coveredGmv = 0;
  var cityTotals = {};
  gmvRows.forEach(function(r) {
    var storeId = String(r[0] || '').trim();
    var addrId = String(r[1] || '').trim();
    var city = String(r[2] || '').trim().toUpperCase();
    var gmv = toNumber_(r[3]) || 0;
    var isCovered = !!(coveredStoreIds[storeId] || coveredAddrIds[addrId]);

    totalGmv += gmv;
    if (isCovered) coveredGmv += gmv;

    if (!cityTotals[city]) cityTotals[city] = { totalGmv: 0, coveredGmv: 0 };
    cityTotals[city].totalGmv += gmv;
    if (isCovered) cityTotals[city].coveredGmv += gmv;
  });

  var cities = SUMMARY_CITIES.map(function(city) {
    var ct = cityTotals[city] || { totalGmv: 0, coveredGmv: 0 };
    return {
      city: city,
      partners: cityPartnerCounts[city] || 0,
      totalGmv: ct.totalGmv,
      coveredGmv: ct.coveredGmv,
      pctGmvCovered: ct.totalGmv ? ct.coveredGmv / ct.totalGmv : 0
    };
  });

  // Blended across just our 6 priority cities (KTW excluded) - the first 6
  // entries of SUMMARY_CITIES - so the UI can show this next to the
  // total-Poland number for context (that one is always lower, diluted by
  // every smaller city where the tracker barely has any coverage).
  var TOP6_CITIES = ['WAW', 'KRA', 'GDN', 'LOD', 'POZ', 'WRO'];
  var top6TotalGmv = 0;
  var top6CoveredGmv = 0;
  TOP6_CITIES.forEach(function(city) {
    var ct = cityTotals[city] || { totalGmv: 0, coveredGmv: 0 };
    top6TotalGmv += ct.totalGmv;
    top6CoveredGmv += ct.coveredGmv;
  });
  var pctGmvCoveredTop6 = top6TotalGmv ? top6CoveredGmv / top6TotalGmv : 0;

  var generatedAt = new Date().toISOString();
  var statusSheet = ss.getSheetByName(DATA_PULL_STATUS_SHEET);
  if (statusSheet && statusSheet.getLastRow() >= 2) {
    var statusRows = statusSheet.getRange(2, 1, statusSheet.getLastRow() - 1, 4).getValues();
    for (var i = 0; i < statusRows.length; i++) {
      if (String(statusRows[i][0]) === 'National_GMV' && statusRows[i][3] instanceof Date) {
        generatedAt = statusRows[i][3].toISOString();
        break;
      }
    }
  }

  return {
    generatedAt: generatedAt,
    pctGmvCovered: totalGmv ? coveredGmv / totalGmv : 0,
    coveredGmv: coveredGmv,
    totalGmv: totalGmv,
    pctGmvCoveredTop6: pctGmvCoveredTop6,
    cities: cities
  };
}

/**
 * One-time backfill: fills blank GMV Weight (BTU!D) for BTU rows whose
 * Store ID (BTU!C) matches a "sid" in the "gmv data" sheet (C = sid,
 * F = store_share_of_city_gmv). Run manually from the Apps Script editor
 * after adding new partners/cities to BTU. Rows that already have a GMV
 * Weight are left untouched.
 */
function backfillBTUGmvWeightsFromGmvData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var btuSheet = ss.getSheetByName('BTU');
  var gmvSheet = ss.getSheetByName('gmv data');
  if (!btuSheet || !gmvSheet) {
    Logger.log('backfillBTUGmvWeightsFromGmvData: BTU or "gmv data" sheet not found.');
    return { status: 'ERROR', reason: 'BTU or "gmv data" sheet not found.' };
  }

  var gmvLastRow = gmvSheet.getLastRow();
  if (gmvLastRow < 2) return { status: 'SKIPPED', reason: '"gmv data" is empty.' };

  var gmvRows = gmvSheet.getRange(2, 1, gmvLastRow - 1, 6).getValues(); // A:F
  var shareBySid = {};
  gmvRows.forEach(function(row) {
    var sid = String(row[1] || '').trim();  // B = sid
    var share = toNumber_(row[5]);          // F = store_share_of_city_gmv
    if (sid && share !== null) shareBySid[sid] = share;
  });

  var btuLastRow = btuSheet.getLastRow();
  if (btuLastRow < 2) return { status: 'SKIPPED', reason: 'BTU is empty.' };

  var btuRows = btuSheet.getRange(2, 1, btuLastRow - 1, 4).getValues(); // A:D
  var updates = 0;

  btuRows.forEach(function(row, idx) {
    var gmvWeight = row[3];
    // Traktujemy puste pole ORAZ 0 jako "jeszcze nieobliczone" — prawdziwy
    // udział w GMV praktycznie nigdy nie wychodzi idealnie 0.
    if (gmvWeight !== '' && gmvWeight !== null && gmvWeight !== 0) return; // already has a value, leave it

    var storeId = String(row[2] || '').trim(); // C = Store ID
    var share = shareBySid[storeId];
    if (share === undefined) return; // no match in "gmv data"

    btuSheet.getRange(idx + 2, 4).setValue(share);
    updates++;
  });

  Logger.log('backfillBTUGmvWeightsFromGmvData: updated ' + updates + ' row(s).');
  return { status: 'SUCCESS', updated: updates };
}

/**
 * One-time backfill: fills blank/zero GMV Weight (Christmas!D) from the
 * REAL BigQuery "National_GMV" sheet instead of the legacy "gmv data"
 * sheet BTU uses - computed as each store's avg_daily_gmv divided by the
 * total avg_daily_gmv of all stores in that same city.
 *
 * NOTE: unlike BTU, Christmas's Summary card and its "Total Poland GMV in
 * Promo" KPI do NOT read this column at all - they match tracker rows to
 * National_GMV directly by Store ID (getTrackerNationalGmvCoverage). This
 * backfill is only for your own reference/sorting by partner size; the
 * one field that actually has to be filled in for the Summary numbers to
 * be correct is Store ID.
 *
 * Run manually from the Apps Script editor (backfillChristmasGmvWeights)
 * after adding new partners/cities, or whenever National_GMV is refreshed.
 */
function backfillTrackerGmvWeightsFromNationalGmv(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var trackerSheet = ss.getSheetByName(sheetName);
  var gmvSheet = ss.getSheetByName(DATA_PULL_NATIONAL_GMV_SHEET);
  if (!trackerSheet || !gmvSheet) {
    Logger.log('backfillTrackerGmvWeightsFromNationalGmv: ' + sheetName + ' or "' + DATA_PULL_NATIONAL_GMV_SHEET + '" sheet not found.');
    return { status: 'ERROR', reason: sheetName + ' or "' + DATA_PULL_NATIONAL_GMV_SHEET + '" sheet not found.' };
  }

  var gmvLastRow = gmvSheet.getLastRow();
  if (gmvLastRow < 2) return { status: 'SKIPPED', reason: '"' + DATA_PULL_NATIONAL_GMV_SHEET + '" is empty - run refreshNationalGmv() first.' };

  // National_GMV columns: store_id, store_address_id, city_code, avg_daily_gmv
  var gmvRows = gmvSheet.getRange(2, 1, gmvLastRow - 1, 4).getValues();
  var storeGmv = {};   // store_id -> {city, gmv}
  var cityTotals = {}; // city -> total gmv
  gmvRows.forEach(function(row) {
    var storeId = String(row[0] || '').trim();
    var city = String(row[2] || '').trim().toUpperCase();
    var gmv = toNumber_(row[3]) || 0;
    if (!storeId || !city) return;
    if (!storeGmv[storeId]) storeGmv[storeId] = { city: city, gmv: 0 };
    storeGmv[storeId].gmv += gmv;
    cityTotals[city] = (cityTotals[city] || 0) + gmv;
  });

  var shareByStoreId = {};
  Object.keys(storeGmv).forEach(function(storeId) {
    var s = storeGmv[storeId];
    var cityTotal = cityTotals[s.city];
    if (cityTotal) shareByStoreId[storeId] = s.gmv / cityTotal;
  });

  var trackerLastRow = trackerSheet.getLastRow();
  if (trackerLastRow < 2) return { status: 'SKIPPED', reason: sheetName + ' is empty.' };

  var trackerRows = trackerSheet.getRange(2, 1, trackerLastRow - 1, 4).getValues(); // A:D
  var updates = 0;

  trackerRows.forEach(function(row, idx) {
    var gmvWeight = row[3];
    if (gmvWeight !== '' && gmvWeight !== null && gmvWeight !== 0) return; // already has a value, leave it

    var storeId = String(row[2] || '').trim(); // C = Store ID
    var share = shareByStoreId[storeId];
    if (share === undefined) return; // no match in National_GMV

    trackerSheet.getRange(idx + 2, 4).setValue(share);
    updates++;
  });

  Logger.log('backfillTrackerGmvWeightsFromNationalGmv(' + sheetName + '): updated ' + updates + ' row(s).');
  return { status: 'SUCCESS', updated: updates };
}

function backfillChristmasGmvWeights() {
  return backfillTrackerGmvWeightsFromNationalGmv('Christmas');
}

// Which tracker (sheet name) a submitted promo's Promo Purpose belongs to,
// if any - e.g. 'Back to University' -> 'BTU', 'Get Ready for Christmas' ->
// 'Christmas'. Returns null for a Promo Purpose with no matching tracker.
function trackerSheetForPromoPurpose_(promoPurpose) {
  var purposes = splitPromoPurposes_(promoPurpose);
  if (!purposes.length) return null;
  var match = Object.keys(TRACKER_DEFINITIONS).filter(function(sheetName) {
    return promoPurposeIncludes_(promoPurpose, TRACKER_DEFINITIONS[sheetName].promoPurpose);
  });
  return match.length ? match[0] : null;
}

// ============================================================
// PRIME WEEK QUALIFICATION LIST ("Prime Partners" tab)
// ============================================================
// Weeks 48-49, 23 Nov - 6 Dec: a partner is added automatically once an
// APPROVED promo of theirs (a) has "Prime Week" among its Promo Purpose(s),
// (b) is either a BPP promo with BPP Discount >= 20%, OR a Prime Exclusive
// promo with Standard Discount >= 20%, and (c) its dates overlap the Prime
// Week window. Unlike BTU/Christmas this is a qualification list, not a
// pitching tracker - unapproved promos are never added.
var PRIME_WEEK_SHEET = 'Prime Partners';
var PRIME_WEEK_START = '2026-11-23';
var PRIME_WEEK_END = '2026-12-06';
var PRIME_WEEK_MIN_BPP_DISCOUNT = 0.20; // decimal fraction, same scale as Master_Log columns N/O

function promoQualifiesForPrimeWeek_(promoPurpose, promoStrategy, bppDiscountDecimal, standardDiscountDecimal, startVal, endVal) {
  if (!promoPurposeIncludes_(promoPurpose, 'Prime Week')) return false;

  var strategy = String(promoStrategy || '').trim().toUpperCase();
  var relevantDiscount;
  if (strategy === 'BPP') {
    relevantDiscount = Number(bppDiscountDecimal);
  } else if (strategy === 'PRIME EXCLUSIVE') {
    relevantDiscount = Number(standardDiscountDecimal);
  } else {
    return false;
  }

  if (!isFinite(relevantDiscount) || relevantDiscount < PRIME_WEEK_MIN_BPP_DISCOUNT) return false;

  var start = parseDateOnly_(startVal);
  var end = parseDateOnly_(endVal);
  if (!start || !end) return false;

  var winStart = parseDateOnly_(PRIME_WEEK_START);
  var winEnd = parseDateOnly_(PRIME_WEEK_END);
  return start <= winEnd && end >= winStart;
}

function ensurePrimePartnersHeader_(sheet) {
  var headers = [
    'Partner Name', 'Store Address ID', 'Account Manager', 'Start Date', 'End Date',
    'Discount %', 'Promo Strategy', 'Promo Purpose', 'Linked Promo ID', 'Added At'
  ];
  if (sheet.getLastRow() < 1 || sheet.getRange(1, 1).getValue() !== headers[0]) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return headers.length;
}

// Adds or updates (by Partner Name + Store Address ID) a row in "Prime
// Partners", but only if the promo actually qualifies. Safe to call for
// every APPROVED promo - non-qualifying ones are silently skipped.
function upsertPrimePartnerRow_(partnerName, storeAddressId, accountManager, startVal, endVal,
                                 promoStrategy, bppDiscountDecimal, standardDiscountDecimal, promoPurpose, promoId) {
  if (!promoQualifiesForPrimeWeek_(promoPurpose, promoStrategy, bppDiscountDecimal, standardDiscountDecimal, startVal, endVal)) return;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PRIME_WEEK_SHEET);
  if (!sheet) sheet = ss.insertSheet(PRIME_WEEK_SHEET);
  ensurePrimePartnersHeader_(sheet);

  var nameKey = normalizeBTUName_(partnerName);
  var addrKey = String(storeAddressId || '').trim();
  var lastRow = sheet.getLastRow();
  var existingRow = -1;

  if (lastRow >= 2) {
    var rows = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (normalizeBTUName_(rows[i][0]) === nameKey && String(rows[i][1] || '').trim() === addrKey) {
        existingRow = i + 2;
        break;
      }
    }
  }

  var strategyUpper = String(promoStrategy || '').trim().toUpperCase();
  var discountUsed = strategyUpper === 'BPP' ? bppDiscountDecimal : standardDiscountDecimal;

  var values = [
    partnerName,
    storeAddressId || 'ALL',
    accountManager || '',
    startVal,
    endVal,
    discountUsed,
    promoStrategy,
    promoPurpose,
    promoId || '',
    Utilities.formatDate(new Date(), "GMT+2", "yyyy-MM-dd HH:mm")
  ];

  var targetRow = existingRow > 0 ? existingRow : sheet.getLastRow() + 1;
  sheet.getRange(targetRow, 1, 1, values.length).setValues([values]);
  sheet.getRange(targetRow, 6).setNumberFormat('0%');
  sheet.getRange(targetRow, 4, 1, 2).setNumberFormat('yyyy-mm-dd');
}

// One-time / on-demand full rebuild from Master_Log. Run manually from the
// Apps Script editor (function dropdown) if historical APPROVED promos need
// backfilling into "Prime Partners" after this feature shipped.
function refreshPrimePartnersFromMasterLog() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var master = ss.getSheetByName('Master_Log');
  if (!master || master.getLastRow() < 2) {
    return { status: 'SKIPPED', reason: 'Master_Log is empty.' };
  }

  var rows = master.getRange(2, 1, master.getLastRow() - 1, 43).getValues();
  var partners = getPartnersMasterData_();
  var approvedCount = 0;
  var qualifiedCount = 0;

  rows.forEach(function(row) {
    var status = String(row[2] || '').trim().toUpperCase();
    if (status !== 'APPROVED') return;
    approvedCount++;

    if (promoQualifiesForPrimeWeek_(row[6], row[12], row[14], row[13], row[9], row[10])) {
      qualifiedCount++;
    }

    var partnerMaster = findPartnerMaster_(String(row[4] || ''), partners);
    upsertPrimePartnerRow_(
      row[4], row[5], partnerMaster ? partnerMaster.accountManager : (row[39] || ''),
      row[9], row[10], row[12], row[14], row[13], row[6], row[0]
    );
  });

  Logger.log('refreshPrimePartnersFromMasterLog: ' + approvedCount + ' approved rows scanned, ' + qualifiedCount + ' qualified.');
  return { status: 'SUCCESS', approvedScanned: approvedCount, qualified: qualifiedCount };
}

// Read-only list for the "Prime Week" tab in the app. No stats, just the
// qualified-partner rows as they sit in the "Prime Partners" sheet.
function getPrimePartners() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PRIME_WEEK_SHEET);
  if (!sheet) sheet = ss.insertSheet(PRIME_WEEK_SHEET);
  var headerLen = ensurePrimePartnersHeader_(sheet);

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var rows = sheet.getRange(2, 1, lastRow - 1, headerLen).getValues();
  return rows
    .filter(function(r) { return String(r[0] || '').trim() !== ''; })
    .map(function(r) {
      return {
        partnerName: String(r[0] || ''),
        storeAddressId: String(r[1] || ''),
        accountManager: String(r[2] || ''),
        startDate: r[3] instanceof Date ? Utilities.formatDate(r[3], "GMT+2", "yyyy-MM-dd") : String(r[3] || ''),
        endDate: r[4] instanceof Date ? Utilities.formatDate(r[4], "GMT+2", "yyyy-MM-dd") : String(r[4] || ''),
        discountPct: typeof r[5] === 'number' ? r[5] : toNumber_(r[5]),
        promoStrategy: String(r[6] || ''),
        promoPurpose: String(r[7] || ''),
        linkedPromoId: String(r[8] || ''),
        addedAt: String(r[9] || '')
      };
    });
}

// Lets an AM add a partner to "Prime Partners" directly, without going
// through Create Promo. Still enforces the same rule as the automatic
// path: BPP or Prime Exclusive, >=20% discount, dates overlapping the
// Prime Week window - just with clear error messages instead of a silent
// no-op.
function addPrimePartnerManual(data) {
  var partnerName = String((data && data.partnerName) || '').trim();
  if (!partnerName) throw new Error('Partner Name is required.');

  var startVal = data && data.startDate;
  var endVal = data && data.endDate;
  if (!startVal || !endVal) throw new Error('Start Date and End Date are required.');

  var strategy = String((data && data.promoStrategy) || 'BPP').trim();
  var strategyUpper = strategy.toUpperCase();
  if (strategyUpper !== 'BPP' && strategyUpper !== 'PRIME EXCLUSIVE') {
    throw new Error('Promo Strategy must be BPP or Prime Exclusive.');
  }

  var discount = getDiscountNumber_(data && data.discount);
  if (discount === null || discount < PRIME_WEEK_MIN_BPP_DISCOUNT) {
    throw new Error('Discount must be at least 20%.');
  }

  var start = parseDateOnly_(startVal);
  var end = parseDateOnly_(endVal);
  var winStart = parseDateOnly_(PRIME_WEEK_START);
  var winEnd = parseDateOnly_(PRIME_WEEK_END);
  if (!start || !end || !(start <= winEnd && end >= winStart)) {
    throw new Error('Dates must overlap the Prime Week window (' + PRIME_WEEK_START + ' to ' + PRIME_WEEK_END + ').');
  }

  var bppDiscount = strategyUpper === 'BPP' ? discount : null;
  var standardDiscount = strategyUpper === 'PRIME EXCLUSIVE' ? discount : null;

  var partnerMaster = findPartnerMaster_(partnerName, getPartnersMasterData_());
  upsertPrimePartnerRow_(
    partnerName, (data && data.storeAddressId) || 'ALL',
    partnerMaster ? partnerMaster.accountManager : '',
    startVal, endVal, strategy, bppDiscount, standardDiscount, 'Prime Week', 'MANUAL'
  );

  return { status: 'SUCCESS' };
}

function upsertTrackerPartnerFromPromo_(sheetName, promoData, promoId, masterRowIndex) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  ensureBTUHeader_(sheet);

  var name = String(promoData.partnerName || '').trim();
  if (!name) return;

  var rows = getTracker_(sheetName).rows;
  var key = normalizeBTUName_(name);
  var existing = rows.find(function(r) { return normalizeBTUName_(r.storeName) === key; });

  if (existing) {
    sheet.getRange(existing.rowIndex, 7).setValue('Yes');
    sheet.getRange(existing.rowIndex, 11).setValue(promoId || '');
    sheet.getRange(existing.rowIndex, 12).setValue(new Date());
    return;
  }

  var partners = getPartnersMasterData_();
  var partner = partners.find(function(p) { return normalizeBTUName_(p.storeName) === key; });

  sheet.appendRow([
    '',
    name,
    promoData.storeAddressId || '',
    '',
    partner ? partner.accountManager : '',
    partner ? (partner.team || partner.teamGroup || '') : '',
    'Yes',
    '',
    '',
    '',
    promoId || '',
    new Date(),
    'Added from Card 1',
    ''
  ]);
}

/**
 * Pobiera listę partnerów uprawnionych do budżetu Top 3
 */
function getTop3PartnersMaster_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Top3_Partners');
  if (!sheet || sheet.getLastRow() < 1) return [];

  var values = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
  return values.map(function(r) { return normalizeName_(r[0]); }).filter(Boolean);
}

/**
 * Endpoint dla frontendu do sprawdzenia, czy partner jest w Top 3
 */
function checkIsTop3Partner(partnerName) {
  var top3List = getTop3PartnersMaster_();
  var target = normalizeName_(partnerName);
  return top3List.indexOf(target) !== -1;
}

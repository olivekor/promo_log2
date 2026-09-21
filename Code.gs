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
    ORDER BY times_bought DESC, product_gmv DESC
    LIMIT 50;
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
  var s = String(value).trim().replace('%', '').replace(',', '.');
  var n = Number(s);
  if (isNaN(n)) return null;
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

  var gmvUplift = mx ? mx.gmvUplift : null;
  var ordersUplift = mx ? mx.ordersUplift : null;
  var promoProductsUplift = mx ? mx.promoProductsUplift : null;
  var promoOrdersPct = mx ? mx.penetration : null;
  var costIntensity = mx ? mx.costIntensity : null;

  var primeShare = 0;
  if (String(promoData.promoStrategy || '').trim().toUpperCase() === 'BPP') {
    primeShare = mx && mx.primeShare !== null ? mx.primeShare : 0.408;
  }

  var forecastedGmv = baselineGmv !== null && gmvUplift !== null ? baselineGmv * gmvUplift : null;
  var forecastedOrders = baselineOrders !== null && ordersUplift !== null ? baselineOrders * ordersUplift : null;
  var upliftGmv = baselineGmv !== null && gmvUplift !== null ? baselineGmv * (gmvUplift - 1) : null;
  var upliftOrders = baselineOrders !== null && ordersUplift !== null ? baselineOrders * (ordersUplift - 1) : null;

  // upliftGmv/upliftOrders already include the full promo duration because
  // baselineGmv/baselineOrders are calculated for the selected duration.
  // Therefore duration must NOT be multiplied a second time here.
  var incrementalGmv = upliftGmv !== null ? upliftGmv * 0.4 : null;
  var incrementalOrders = upliftOrders !== null ? upliftOrders * 0.4 : null;

  var coverage = getDiscountNumber_(promoData.coverage);
  var estimatedPromoCost = null;
  var typeUpper = String(promoData.promoType || '').trim().toUpperCase();

  // Zmienna promoProductsUpliftMult z macierzy (odpowiada kolumnie Z / promoProductsUplift)
  var promoProductsUpliftMult = mx ? mx.promoProductsUplift : null;

  if (partner) {
    if (typeUpper === 'PERCENTAGE_DISCOUNT' || typeUpper === 'BASKET_PERCENTAGE') {
      if (baselineGmv !== null && coverage !== null && promoProductsUpliftMult !== null && standardDiscount !== null && maxDiscount !== null && primeShare !== null) {
        // Zgodnie z formułą: AC * S * Z * ((1 - AE) * J + AE * V)
        estimatedPromoCost = baselineGmv * coverage * promoProductsUpliftMult *
          ((1 - primeShare) * standardDiscount + primeShare * maxDiscount);
      }
    } else if (forecastedGmv !== null && costIntensity !== null) {
      // Zgodnie z drugą częścią formuły dla pozostałych typów: AF * AB
      estimatedPromoCost = forecastedGmv * costIntensity;
    }
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
    matrixLevel: mx ? mx.level : ''
  };
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

  var baseValues = new Array(43).fill('');
  baseValues[0] = id;
  baseValues[1] = createdAt;
  baseValues[2] = 'PENDING_APPROVAL';
  baseValues[3] = promoData.budgetSource;
  baseValues[4] = promoData.partnerName;
  baseValues[5] = promoData.storeAddressId || 'ALL';
  baseValues[6] = promoData.promoPurpose;
  baseValues[7] = promoData.pitched || 'Yes';
  baseValues[8] = 'Pending';
  baseValues[9] = promoData.startDate;
  baseValues[10] = promoData.endDate;
  baseValues[11] = promoData.promoType;
  baseValues[12] = promoData.promoStrategy;
  baseValues[13] = getDiscountNumber_(promoData.discount);
  baseValues[14] = getDiscountNumber_(promoData.bppDiscount);
  baseValues[15] = promoData.products;
  baseValues[16] = getDiscountNumber_(promoData.cofunding);
  baseValues[41] = promoData.activationMethod;
  baseValues[40] = '';
  baseValues[42] = userEmail;

  sheet.getRange(nextRow, 1, 1, 43).setValues([baseValues]);

  var calc = calculateMasterLog_(promoData);
  writeCalculatedColumns_(sheet, nextRow, calc);

  // Back to University promotions are also tracked in the temporary BTU tracker.
  if (String(promoData.promoPurpose || '').trim().toLowerCase() === 'back to university') {
    try {
      upsertBTUPartnerFromPromo_(promoData, id, nextRow);
    } catch (e) {
      Logger.log('BTU tracker update failed: ' + e.message);
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
    sheet.getRange(rowIdx, 9).setValue('Pending'); // Czyszczenie kolumny Confirmed
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

  // 4. Przeliczamy na nowo metryki
  var calc = calculateMasterLog_(promoData);
  writeCalculatedColumns_(sheet, rowIdx, calc);

  return { status: 'SUCCESS', calculations: calc };
}

/**
 * Opcjonalnie: przelicza wszystkie istniejące wiersze Master_Log.
 */
function recalculateAllMasterLog() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Master_Log');
  if (!sheet || sheet.getLastRow() < 2) return { status: 'SUCCESS', rows: 0 };

  ensureMasterLogHeader_(sheet);
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 42).getValues();
  var count = 0;

  data.forEach(function(row, idx) {
    if (!row[4]) return; // Pomijaj puste wiersze (bez partnera)

    var promoData = {
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
      coverage: row[18]
    };

    var calc = calculateMasterLog_(promoData);
    writeCalculatedColumns_(sheet, idx + 2, calc);
    count++;
  });

  Logger.log('Przeliczono wierszy: ' + count);
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

  // Pobieramy zakres od A2 do AQ{lastRow} (43 kolumny)
  var values = sheet.getRange(2, 1, totalRows, 43).getValues();

  var updatesCost = [];
  var updatesSpend = [];

  values.forEach(function(row) {
    var partnerName = row[4];                            // E (index 4)
    var promoType = String(row[11] || '').trim().toUpperCase(); // L (index 11)
    var standardDiscount = toNumber_(row[13]);           // N (index 13)
    var cofunding = toNumber_(row[16]);                  // Q (index 16)
    var coverage = toNumber_(row[18]);                   // S (index 18)
    var maxDiscount = toNumber_(row[21]);                // V (index 21)
    var promoProductsUpliftMult = toNumber_(row[25]);   // Z (index 25)
    var costIntensity = toNumber_(row[27]);              // AB (index 27)
    var baselineGmv = toNumber_(row[28]);                // AC (index 28)
    var primeShare = toNumber_(row[30]);                 // AE (index 30)
    var forecastedGmv = toNumber_(row[31]);             // AF (index 31)

    var estimatedPromoCost = '';
    var estimatedBudgetSpend = '';

    if (partnerName && String(partnerName).trim() !== '') {

      // Ustalamy wartości domyślne, jeśli w arkuszu brakuje niektórych współczynników
      var currentMaxDiscount = (maxDiscount !== null) ? maxDiscount : (standardDiscount !== null ? standardDiscount : 0);
      var currentPrimeShare = (primeShare !== null) ? primeShare : 0;
      var currentUpliftMult = (promoProductsUpliftMult !== null && promoProductsUpliftMult > 0) ? promoProductsUpliftMult : 1;

      if (promoType === 'PERCENTAGE_DISCOUNT' || promoType === 'BASKET_PERCENTAGE') {
        if (baselineGmv !== null && coverage !== null && standardDiscount !== null) {
          // Formuła AL: AC * S * Z * ((1 - AE) * N + AE * V)
          estimatedPromoCost = baselineGmv * coverage * currentUpliftMult *
            ((1 - currentPrimeShare) * standardDiscount + currentPrimeShare * currentMaxDiscount);
        }
      } else if (forecastedGmv !== null && costIntensity !== null) {
        // Formuła AL dla pozostałych: AF * AB
        estimatedPromoCost = forecastedGmv * costIntensity;
      }

      if (estimatedPromoCost !== '' && estimatedPromoCost !== null && cofunding !== null) {
        // Formuła AM: AL * Q
        estimatedBudgetSpend = estimatedPromoCost * cofunding;
      }
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
 * - Prime Days
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
  'Prime Days',
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
   * PRIME DAYS
   */
  if (
    p === 'prime days' ||
    p === 'prime day' ||
    p === 'primedays' ||
    p === 'prime_day'
  ) {
    return 'Prime Days';
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
  'karolina.stanecka@glovoapp.com'
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
 * getPitchingOverview('Prime Days')
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
     * Promo Purpose
     */
    var purpose =
      normalizePitchingPurpose_(
        row[6]
      );


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

    if (!purpose) {
      continue;
    }


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
    'Source'
  ];

  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
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

function getBTUTracker() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('BTU');

  Logger.log('BTU DEBUG 0 - function started');
  Logger.log('BTU DEBUG 0a - spreadsheet: ' + ss.getName());
  Logger.log('BTU DEBUG 0b - sheet found: ' + !!sheet);

  if (!sheet) {
    sheet = ss.insertSheet('BTU');
    Logger.log('BTU DEBUG 0c - BTU sheet was missing, created new sheet');
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

  var values = sheet.getRange(2, 1, lastRow - 1, 13).getValues();

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

    if (!name || purpose !== 'back to university') return;

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
      source: String(r[12] || 'Initial BTU list')
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
        bppWeight: 0,
        prime5Weight: 0,
        total: 0,
        onPromo: 0,
        highDiscount: 0,
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
    var prime = String(r.prime10 || '').trim().toLowerCase() === 'yes';
    var prime5 = String(r.prime5 || '').trim().toLowerCase() === 'yes';

    if (onPromo) { c.onPromo++; c.promoWeight += w; }
    if (high) { c.highDiscount++; c.highDiscountWeight += w; }
    if (prime) { c.prime10++; }
    if (prime5) { c.prime5++; c.prime5Weight += w; }

    // BPP/Prime is represented by the tracker Prime flag for the BTU view.
    if (prime) c.bppWeight += w;
  });

  var list = Object.keys(cities).map(function(k) {
    var c = cities[k];
    return {
      city: c.city,
      total: c.total,
      totalWeight: c.totalWeight,
      onPromo: c.onPromo,
      highDiscount: c.highDiscount,
      prime10: c.prime10,
      prime5: c.prime5,
      promoRate: c.totalWeight ? c.promoWeight / c.totalWeight : 0,
      highDiscountRate: c.totalWeight ? c.highDiscountWeight / c.totalWeight : 0,
      bppRate: c.totalWeight ? c.bppWeight / c.totalWeight : 0,
      prime5Rate: c.totalWeight ? c.prime5Weight / c.totalWeight : 0,
      // Keep the legacy naming for the UI.
      springPromoRate: c.totalWeight,
      promoGmvRate: c.totalWeight ? c.promoWeight / c.totalWeight : 0
    };
  });

  list.sort(function(a,b) { return b.totalWeight - a.totalWeight || a.city.localeCompare(b.city); });

  var total = rows.length;
  var totalWeight = rows.reduce(function(sum, r) { return sum + (Number(r.gmvWeight) || 0); }, 0);
  var onPromo = rows.filter(function(r){ return String(r.onPromo).toLowerCase() === 'yes'; });
  var highDiscount = rows.filter(function(r){ return String(r.highDiscount).toLowerCase() === 'yes'; });
  var prime10 = rows.filter(function(r){ return String(r.prime10).toLowerCase() === 'yes'; });
  var prime5 = rows.filter(function(r){ return String(r.prime5).toLowerCase() === 'yes'; });

  return {
    total: total,
    totalWeight: totalWeight,
    onPromo: onPromo.length,
    highDiscount: highDiscount.length,
    prime10: prime10.length,
    prime5: prime5.length,
    promoRate: total ? onPromo.length / total : 0,
    cities: list
  };
}

function saveBTUTrackerRow(rowData) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('BTU');
  if (!sheet) throw new Error('Nie znaleziono arkusza BTU.');
  ensureBTUHeader_(sheet);

  var rowIndex = Number(rowData.rowIndex);
  if (!rowIndex || rowIndex < 2 || rowIndex > sheet.getLastRow()) {
    throw new Error('Nieprawidłowy numer wiersza BTU.');
  }

  var accountManager = String(rowData.accountManager || '').trim();
  var amKey = accountManager.toLowerCase();
  var amTeamMap = getBTUAmTeamMap_();
  var managerMap = getBTUAmMetaMap_();
  var teamMeta = amTeamMap[amKey] || {};
  var team = String(teamMeta.team || rowData.team || '').trim();

  sheet.getRange(rowIndex, 1, 1, 13).setValues([[
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
    rowData.source || 'Manual'
  ]]);

  return { status: 'SUCCESS', rowIndex: rowIndex, accountManager: accountManager, team: team, manager: managerMap[amKey] || '' };
}

function addBTUPartner(rowData) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('BTU');
  if (!sheet) sheet = ss.insertSheet('BTU');
  ensureBTUHeader_(sheet);

  var name = String(rowData.storeName || '').trim();
  if (!name) throw new Error('Podaj nazwę partnera.');

  var existing = getBTUTracker().rows;
  var key = normalizeBTUName_(name);
  var duplicate = existing.find(function(r) { return normalizeBTUName_(r.storeName) === key; });
  if (duplicate) return { status: 'EXISTS', rowIndex: duplicate.rowIndex };

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
    'Manual'
  ];

  sheet.appendRow(row);
  return { status: 'SUCCESS', rowIndex: sheet.getLastRow() };
}

function upsertBTUPartnerFromPromo_(promoData, promoId, masterRowIndex) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('BTU');
  if (!sheet) sheet = ss.insertSheet('BTU');
  ensureBTUHeader_(sheet);

  var name = String(promoData.partnerName || '').trim();
  if (!name) return;

  var rows = getBTUTracker().rows;
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
    'Added from Card 1'
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

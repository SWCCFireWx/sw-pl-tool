/*
 * SWA Preparedness Level tool — configuration.
 *
 * Everything an operations lead may want to adjust season to season lives here:
 * PSA list, crew and IMT rosters, status codes, element weights and the
 * thresholds that turn raw numbers into adjective ratings.
 * The calculation logic (js/calc.js) reads these values; it has no numbers of its own.
 *
 * Values marked "from spreadsheet" reproduce 2026_SWA_PL_Dashboard_V3_SHOULDER_SEASON_MASTER.xlsx.
 */
(function (root) {
  const CONFIG = {
    version: 1,

    /* Adjective ratings and their multipliers (MISC!A2:B7, from spreadsheet). */
    ratings: ["Minimum", "Low", "Moderate", "High", "Maximum"],
    multipliers: { Minimum: 0, Low: 0.25, Moderate: 0.5, High: 0.75, Maximum: 1, Extreme: 1 },
    /* Inverted scale used for IMT and crew AVAILABILITY (MISC!A18:B22):
       low availability pushes the PL up. */
    invertedMultipliers: { Maximum: 0, High: 0.25, Moderate: 0.5, Low: 0.75, Minimum: 1 },

    /* PL score → PL level (MISC!E2:G6, VLOOKUP approximate match). Lower bound of each level. */
    plLevels: [
      { pl: 1, min: 0 },
      { pl: 2, min: 0.151 },
      { pl: 3, min: 0.386 },
      { pl: 4, min: 0.62 },
      { pl: 5, min: 0.851 },
    ],

    /* Element weights (max contribution to PL, should total 1.0). */
    weightPresets: {
      shoulder: {
        label: "Shoulder season (no IMT or crews)",
        source: "PL_Outcome sheet",
        weights: { fire: 0.3, imt: 0, crews: 0, outlook: 0.4, danger: 0.3 },
      },
      season: {
        label: "Fire season (all elements)",
        source: "PL_Outcome (2) sheet, SWA PL calculation of April 13, 2021",
        weights: { fire: 0.2, imt: 0.2, crews: 0.1, outlook: 0.3, danger: 0.2 },
      },
    },
    defaultPreset: "shoulder",

    elements: [
      { key: "fire", name: "Fire Activity", group: "occurring" },
      { key: "imt", name: "IMT Availability", group: "occurring", inverted: true },
      { key: "crews", name: "T-1/T2IA Crew Availability", group: "occurring", inverted: true },
      { key: "outlook", name: "7-Day Fire Potential Trend", group: "could" },
      { key: "danger", name: "PSA ERCy Indices", group: "could" },
    ],

    /* Fire Activity rating guidance (PL_worksheet!B4:B11, from spreadsheet).
       maxIncidents / maxComplex drive the suggested rating from incident counts. */
    fireActivity: [
      { rating: "Minimum", maxIncidents: 0, maxComplex: 0,
        text: "Little to no fire activity." },
      { rating: "Low", maxIncidents: 3, maxComplex: 1,
        text: "Fire occurrence usually contained in 1 burning period and successfully managed with local resources. Consider Low when there are 3 or fewer incidents of T3 or higher, of which no more than 1 is T2 or higher." },
      { rating: "Moderate", maxIncidents: 7, maxComplex: 2,
        text: "Daily initial attack in some areas, with incidents burning more than 1 burning period and non-local resources needed to assist. Consider Moderate if up to 7 incidents of T3 or higher, of which no more than 2 are T2 or higher." },
      { rating: "High", maxIncidents: 14, maxComplex: 4,
        text: "Most areas experiencing new incidents daily and fires over 100 acres are common. Resource needs across zone boundaries are frequent, with some support from outside the Geographic Area. Consider High if up to 14 incidents of T3 or higher, of which no more than 4 are T2 or higher." },
      { rating: "Maximum", maxIncidents: Infinity, maxComplex: Infinity,
        text: "New-incident initial attack capability is compromised by ongoing large fire activity and lack of resources. Resource requests from outside the Geographic Area are common. Consider Maximum if 15 or more incidents of T3 or higher, of which 5 or more are T2 or higher." },
    ],

    /* Predictive Service Areas. id = 7-Day product id, ercId = NFDRS id. */
    psas: [
      { id: "SW01", ercId: "SW-01", name: "NW AZ" },
      { id: "SW02", ercId: "SW-02", name: "West-Central AZ" },
      { id: "SW03", ercId: "SW-03", name: "SW AZ" },
      { id: "SW04", ercId: "SW-04", name: "4 Corners Area" },
      { id: "SW05", ercId: "SW-05", name: "Western Mogollon Rim" },
      { id: "SW06N", ercId: "SW-06N", name: "Central AZ / PHX Metro" },
      { id: "SW06S", ercId: "SW-06S", name: "SE AZ" },
      { id: "SW07", ercId: "SW-07", name: "NW NM Mtns." },
      { id: "SW08", ercId: "SW-08", name: "White Mtns. / Gila" },
      { id: "SW09", ercId: "SW-09", name: "South / Central NM Lowlands" },
      { id: "SW10", ercId: "SW-10", name: "Sangre de Cristos" },
      { id: "SW11", ercId: "SW-11", name: "Central NM Mtns. & Plains" },
      { id: "SW12", ercId: "SW-12", name: "South-Central NM Mtns." },
      { id: "SW13", ercId: "SW-13", name: "NE & E-Central NM Plains" },
      { id: "SW14N", ercId: "SW-14N", name: "SE NM Plains" },
    ],

    /* 7-Day Significant Fire Potential (7-Day_Dryness sheet). */
    outlook: {
      levels: [
        { value: 1, label: "Little / no risk", short: "Little/No" },
        { value: 2, label: "Low risk", short: "Low" },
        { value: 3, label: "Moderate risk", short: "Moderate" },
        { value: 4, label: "High risk", short: "High" },
      ],
      /* Daily risk score = sum of each PSA's level (green 1, yellow 2, brown 3, red 4).
         With 15 PSAs the score runs 15–60. Rating = first band whose upper bound the score is below. */
      bands: [
        { rating: "Minimum", below: 25 },
        { rating: "Low", below: 37 },
        { rating: "Moderate", below: 46 },
        { rating: "High", below: 52 },
        { rating: "Maximum", below: Infinity },
      ],
    },

    /* Automatic data sources. Used by scripts/update-data.mjs, run at 8 AM and 9 PM Mountain by
       .github/workflows/update-data.yml. The page's "Pull latest from NPSG" button tries NPSG directly too. */
    autoData: {
      timeZone: "America/Denver",
      pullOnLoad: true, // try a live pull when the page opens and the data on hand is out of date
      npsg: {
        // NPSG 7-Day Significant Fire Potential map service: one layer per day (0 = Day 1 … 6 = Day 7).
        outlookService: "https://fsapps.nwcg.gov/psp/arcgis/rest/services/npsg/outlooks_forecast/MapServer",
        psaWhere: "nat_code LIKE 'SW%'",
      },
      fireStarts: {
        // WFIGS incident locations (NIFC), year to date; "current" is the fallback around New Year.
        service: "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_YearToDate/FeatureServer/0",
        fallbackService: "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0",
        states: ["US-AZ", "US-NM", "US-TX", "US-OK"], // narrowed to the SW PSAs by location
        incidentTypes: ["WF"], // wildfires only (no prescribed fire)
        lookbackDays: 7, // each run re-counts the last 7 days, since reports arrive late
        // FireCause → archive category
        causes: { Natural: "lightning", Lightning: "lightning", Human: "human" }, // anything else → unknown
      },
      raws: {
        // FEMS public API (no key needed).
        endpoint: "https://fems.fs2c.usda.gov/api/climatology/graphql",
        // Weather observations: every RAWS station FEMS lists in these states, kept if it sits inside
        // a Southwest PSA (placed by its latitude/longitude on the NPSG PSA outlines).
        weatherStates: ["AZ", "NM", "TX", "OK"],
        weatherNetwork: "RAWS",
        wettingRain: 0.1, // inches in 24 hours
        // Known wind events: high gusts on these days/PSAs are never removed by the weather checks.
        // e.g. [{ date: "2026-04-12", psa: "SW-11" }, { date: "2026-04-12", psa: "all" }]
        windEvents: [],
        // ERC and BI (NFDRS fuel model Y): only these stations, from the SWCC ERC station list.
        fuelModel: "Y",
        nfdrStationsByPsa: {
          "SW-01": [[20207, "Tusayan"], [20212, "Drypark"], [20213, "Frazier Well"]],
          "SW-02": [[20115, "Moss Basin"], [20501, "Iron Springs"], [20509, "Stanton"]],
          "SW-03": [[45801, "Senator Wash"]],
          "SW-04": [[20402, "Piney Hill"], [290101, "Washington Pass"], [290102, "Albino Canyon"]],
          "SW-05": [[20209, "Flagstaff"], [20301, "Heber"], [20303, "Lakeside"]],
          "SW-06N": [[20601, "Globe"], [20606, "Tonto Basin"]],
          "SW-06S": [[21005, "Columbine"], [21007, "Mule Shoe"], [21202, "Saguaro"], [21206, "Sasabe"]],
          "SW-07": [[290702, "Jemez"], [290801, "Tower"], [291302, "Grants"]],
          "SW-08": [[20401, "Alpine"], [292001, "Beaverhead"], [292008, "Slaughter Mesa"], [292009, "Pelona Mtn"]],
          "SW-09": [[292103, "Bosque"], [292702, "Hatchett"], [292903, "Dripping Springs"]],
          "SW-10": [[290210, "Truchas"], [291202, "Pecos"]],
          "SW-11": [[292102, "Chupadera"], [291501, "Mountainair"]],
          "SW-12": [[292203, "Smokey Bear"], [293002, "Mayhill"], [293003, "Mescal"]],
          "SW-13": [[292301, "Eight Mile Draw"], [418701, "Cedar"]],
          "SW-14N": [[292301, "Eight Mile Draw"], [293101, "Batdraw"], [293104, "Caprock"]],
          // Listed by SWCC as "Other": archived station by station, not averaged into a PSA.
          Other: [[20211, "Bright Angel"], [20603, "Pleasant Valley"], [20116, "Union Pass"], [21207, "Rincon"]],
        },
      },
      sharepoint: {
        // Public ("anyone with the link") FireNet SharePoint workbooks, updated daily by SWCC.
        crewsUrl: "https://firenet365.sharepoint.com/:x:/s/SWCC_Expanded__Daily_Logs__Website_Docs__Mob_Centers_/IQDbuynVt9NXiLOAak5hr0lpAaKsZvXneygZ3En3HoxpULs",
        crewSheets: { swa: "SWA Type 1 IHC", ooa: "OOA Type 1 IHC" },
        imtUrl: "https://firenet365.sharepoint.com/:x:/s/SWCC_Expanded__Daily_Logs__Website_Docs__Mob_Centers_/EdKzayRbEQ1Hpz-s-XoXkrABtWhlxspGPSHX69e0GsV_qg",
        imtSheet: "Incident Management Teams",
      },
    },

    /* PSA ERCy percentiles (PSA_ERCy_Values!D28). */
    danger: {
      extremeCount: 8, // 8+ PSAs at 97th+ percentile → Extreme
      // Otherwise: any PSA ≥97 → High; any 90–96 → Moderate; any 50–89 → Low; else Minimum.
    },

    /* IMT roster and status codes (IMT's sheet). */
    imtTypes: ["CIMT", "OOA CIMT", "3", "NIMO", "AC"],
    imtStatuses: [
      { code: "AN", label: "Available – National", group: "available" },
      { code: "AG", label: "Available – Geographic Area", group: "available" },
      { code: "AL", label: "Available – Local", group: "available" },
      { code: "C", label: "Committed", group: "committed" },
      { code: "O-R", label: "Off rotation", group: "unavailable" },
      { code: "U", label: "Unavailable", group: "unavailable" },
      { code: "UE", label: "Unavailable – end of season", group: "unavailable" },
    ],
    imts: [
      { mob: "SW", type: "CIMT", zone: "1", ic: "Finch", home: "NM-SWC", status: "AN" },
      { mob: "SW", type: "CIMT", zone: "2", ic: "Truett", home: "NM-SWC", status: "O-R" },
      { mob: "SW", type: "CIMT", zone: "3", ic: "Rau", home: "NM-SWC", status: "O-R" },
      { mob: "SW", type: "CIMT", zone: "4", ic: "Mandell", home: "NM-SWC", status: "O-R" },
      { mob: "AZ", type: "3", zone: "CWZ", ic: "Stewart", home: "AZ-PDC", status: "UE" },
      { mob: "AZ", type: "3", zone: "NAZ", ic: "Causer", home: "AZ-FDC", status: "UE" },
      { mob: "AZ", type: "3", zone: "SEZ", ic: "Rice", home: "AZ-TDC", status: "UE" },
      { mob: "AZ", type: "3", zone: "WMZ", ic: "Gabler", home: "AZ-SDC", status: "UE" },
      { mob: "NM", type: "3", zone: "ABZ", ic: "Baca", home: "NM-ABC", status: "UE" },
      { mob: "NM", type: "3", zone: "PEZ", ic: "Curnutt", home: "NM-ADC", status: "UE" },
      { mob: "NM", type: "3", zone: "NNMZ", ic: "Griego", home: "NM-SFC", status: "UE" },
      { mob: "NM", type: "3", zone: "GLZ", ic: "Cornwell", home: "NM-SDC", status: "UE" },
    ],

    /* Crew status codes (Crews_raw column G dropdown) and how each is counted. */
    crewStatuses: [
      { code: "A", label: "Available – National", group: "available" },
      { code: "AG", label: "Available – Geographic Area", group: "available" },
      { code: "AL", label: "Available – Local", group: "local" },
      { code: "AD", label: "Available – day off", group: "available" },
      { code: "P", label: "Prepositioned (set location)", group: "prepo" },
      { code: "C", label: "Committed in SWA", group: "committed" },
      { code: "C-O", label: "Committed out of area", group: "committedOut" },
      { code: "TI", label: "Travel to incident", group: "travel" },
      { code: "R", label: "Reassigned", group: "travel" },
      { code: "MD", label: "Mandatory day off", group: "unavailable" },
      { code: "U", label: "Unavailable", group: "unavailable" },
      { code: "UD", label: "Unavailable – day off", group: "unavailable" },
      { code: "UE", label: "Unavailable – end of season", group: "unavailable" },
      { code: "RE", label: "Released / returned", group: "released" },
      { code: "RA", label: "Returned from assignment", group: "released" },
      { code: "TP", label: "TP (not counted)", group: "other" },
    ],
    /* A crew with status P counts as available only when prepositioned at this location. */
    prepoAvailableLocation: "SWCC",
    crewAvailability: {
      /* Spreadsheet counts OOA crews only when prepositioned at SWCC.
         true also counts OOA crews with an available status (A, AG, AD). */
      includeOOAAvailable: true,
      // ratio = available crews ÷ number of SWA crews. Rating = first band the ratio exceeds.
      bands: [
        { rating: "Maximum", atLeast: 1 },
        { rating: "High", above: 0.6 },
        { rating: "Moderate", above: 0.39 },
        { rating: "Low", above: 0.11 },
        { rating: "Minimum", above: -Infinity },
      ],
    },
    dispatchCenters: ["SWCC", "ADC", "ABC", "FDC", "PHC", "PDC", "SDC", "SFC", "TDC", "WDC",
      "AICC", "EACC", "GBCC", "ONCC", "OSCC", "NRCC", "NWCC", "RMCC", "SACC", "NICC"],
    dayOffOptions: ["Mo-Tu", "Tu-We", "We-Th", "Th-Fr", "Fr-Sa", "Sa-Su", "Su-Mo"],
    crewTypes: ["CRW1", "CR2I"],
    crews: [
      ["Aravaipa", "CRW1", "AZ", "TDC", "GID", "Sa-Su", "UE 9/11"],
      ["Black Mesa", "CR2I", "AZ", "SDC", "ASF", "Mo-Tu", "UE 8/30"],
      ["Blue Ridge", "CRW1", "AZ", "FDC", "COF", "Mo-Tu", "UE 9/21"],
      ["Flagstaff", "CRW1", "AZ", "FDC", "COF", "Fr-Sa", "UE 9/5"],
      ["Ft. Apache", "CR2I", "AZ", "SDC", "FTA", "Th-Fr", "UE 9/30"],
      ["Geronimo", "CR2I", "AZ", "PHC", "SCA", "Sa-Su", "UE 9/21"],
      ["Globe", "CRW1", "AZ", "PHC", "TNF", "Fr-Sa", "UE 9/20"],
      ["Mesa", "CRW1", "AZ", "PHC", "TNF", "We-Th", "UE 9/15"],
      ["Mormon Lake", "CRW1", "AZ", "FDC", "COF", "We-Th", "UE 9/15"],
      ["Navajo", "CRW1", "AZ", "FDC", "NAA", "Sa-Su", "UE 9/26"],
      ["Payson", "CRW1", "AZ", "PHC", "TNF", "Mo-Tu", "UE 9/25"],
      ["Prescott", "CRW1", "AZ", "PDC", "PNF", "Th-Fr", "UE 9/30"],
      ["Carson", "CRW1", "NM", "TDC", "CAF", "Fr-Sa", "UE 9/14"],
      ["Gila", "CRW1", "NM", "SDC", "GNF", "Fr-Sa", "UE 9/22"],
      ["Mt. Taylor", "CRW1", "NM", "ABC", "CIF", "Fr-Sa", "UE 9/7"],
      ["Sacramento", "CR2I", "NM", "ADC", "LNF", "Mo-Tu", "UE 9/14"],
      ["Santa Fe", "CRW1", "NM", "SFC", "SNF", "We-Th", "UE 9/30"],
      ["Silver City", "CRW1", "NM", "SDC", "GNF", "Tu-We", "UE 9/1"],
      ["Smokey Bear", "CRW1", "NM", "ADC", "LNF", "Sa-Su", "UE 8/29"],
      ["Zuni", "CR2I", "NM", "ABC", "ZUA", "Sa-Su", "UE 7/24"],
    ].map(([name, type, state, disp, unit, dayOff, remarks]) => ({
      name, type, state, disp, unit, dayOff, status: "UE", location: "", incident: "", dateCom: "", remarks,
    })),
  };

  if (typeof module !== "undefined" && module.exports) module.exports = CONFIG;
  else root.PL_CONFIG = CONFIG;
})(typeof window !== "undefined" ? window : globalThis);

export default async function install(app) {
  const panel = app.getMount("station-workflow");
  const stationLayer = app.layers[app.config.stationLayerId];
  app.assert(stationLayer, "The police-station layer is unavailable.");
  const [serviceArea, networkService, ServiceAreaParameters, FeatureSet, Graphic, Portal] = await Promise.all([
    app.import("esri/rest/serviceArea"),
    app.import("esri/rest/networkService"),
    app.import("esri/rest/support/ServiceAreaParameters"),
    app.import("esri/rest/support/FeatureSet"),
    app.import("esri/Graphic"),
    app.import("esri/portal/Portal")
  ]);
  const areas = await app.createResultLayer({
    id: "selected-service-area",
    title: "10-minute driving-time area",
    geometryType: "polygon",
    fields: [{ name: "Station", type: "string" }, { name: "Minutes", type: "double" }],
    renderer: { type: "simple", symbol: { type: "simple-fill", color: [32, 114, 178, 0.22], outline: { color: [18, 75, 120, 0.9], width: 2 } } },
    popupTemplate: { title: "{Station} driving-time area", content: "{Minutes}-minute service area" }
  });
  const portal = new Portal(app.portalUrl ? { url: app.portalUrl } : {});
  await portal.load();
  const serviceAreaUrl = portal.helperServices?.serviceArea?.url;
  app.assert(serviceAreaUrl, "This portal does not advertise a service-area helper service.");
  let drivingTime;
  let sequence = 0;
  const make = (tag, text) => { const el = document.createElement(tag); el.textContent = text; return el; };
  const status = make("p", "Click a station on the map, or search by facility name or station ID.");
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Search NYPD stations";
  input.setAttribute("aria-label", "Search NYPD stations");
  input.style.width = "100%";
  input.style.boxSizing = "border-box";
  input.style.marginBottom = "8px";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Search stations";
  button.style.marginBottom = "8px";
  const results = document.createElement("div");
  results.setAttribute("aria-live", "polite");
  panel.replaceChildren(status, input, button, results);
  const chooseDrivingTime = async () => {
    if (!drivingTime) {
      const description = await networkService.fetchServiceDescription(serviceAreaUrl);
      drivingTime = (description.supportedTravelModes ?? []).find((mode) => mode.type === "automobile" && mode.impedanceAttributeName === mode.timeAttributeName);
      app.assert(drivingTime, "No time-based driving travel mode is available.");
    }
    return drivingTime;
  };
  const stationName = (feature) => String(feature.attributes?.FACILITY_NAME || feature.attributes?.ID || "NYPD station");
  const selectStation = async (feature) => {
    const current = ++sequence;
    const name = stationName(feature);
    status.textContent = `Generating a ${app.config.minutes}-minute driving-time area for ${name}…`;
    results.replaceChildren();
    try {
      const result = await serviceArea.solve(serviceAreaUrl, new ServiceAreaParameters({
        facilities: new FeatureSet({ features: [new Graphic({ geometry: feature.geometry })] }),
        travelMode: await chooseDrivingTime(),
        defaultBreaks: [app.config.minutes],
        outSpatialReference: app.view.spatialReference,
        trimOuterPolygon: true
      }));
      if (current !== sequence) return;
      const polygons = result.serviceAreaPolygons?.features ?? [];
      if (!polygons.length) { await areas.clear(); status.textContent = `No service area was returned for ${name}.`; return; }
      await areas.replaceFeatures(polygons.map((polygon) => ({ geometry: polygon.geometry, attributes: { Station: name, Minutes: app.config.minutes } })));
      status.textContent = `${app.config.minutes}-minute driving-time area generated for ${name}.`;
      await app.view.goTo(polygons.map((polygon) => polygon.geometry));
    } catch (error) {
      if (current !== sequence) return;
      await areas.clear();
      status.textContent = `Could not generate a service area: ${error?.message || "Unknown error"}`;
    }
  };
  const searchStations = async () => {
    const term = input.value.trim();
    if (!term) { status.textContent = "Enter a facility name or station ID to search."; results.replaceChildren(); return; }
    status.textContent = "Searching stations…";
    results.replaceChildren();
    const safe = term.replace(/'/g, "''").toUpperCase();
    const query = stationLayer.createQuery();
    query.where = `UPPER(FACILITY_NAME) LIKE '%${safe}%' OR UPPER(ID) LIKE '%${safe}%'`;
    query.outFields = ["OBJECTID", "ID", "FACILITY_NAME", "FACILITY_ADDRESS", "BOROUGH", "POLICE_PREC"];
    query.returnGeometry = true;
    try {
      const { features } = await stationLayer.queryFeatures(query);
      if (!features.length) { status.textContent = "No NYPD station matches that search."; return; }
      status.textContent = `${features.length} matching station${features.length === 1 ? "" : "s"}. Choose one to generate its service area.`;
      for (const feature of features.slice(0, 20)) {
        const choice = document.createElement("button");
        choice.type = "button";
        const precinct = feature.attributes?.POLICE_PREC != null ? ` · Precinct ${feature.attributes.POLICE_PREC}` : "";
        choice.textContent = `${stationName(feature)}${precinct}`;
        choice.style.display = "block";
        choice.style.width = "100%";
        choice.style.textAlign = "left";
        choice.style.margin = "4px 0";
        const onChoice = () => selectStation(feature);
        choice.addEventListener("click", onChoice);
        app.onCleanup(() => choice.removeEventListener("click", onChoice));
        results.appendChild(choice);
      }
    } catch (error) { status.textContent = `Search failed: ${error?.message || "Unknown error"}`; }
  };
  app.actions.register("select-station", async ({ graphic }) => {
    const query = stationLayer.createQuery();
    query.objectIds = [graphic.getObjectId()];
    query.outFields = ["OBJECTID", "ID", "FACILITY_NAME", "FACILITY_ADDRESS", "BOROUGH", "POLICE_PREC"];
    query.returnGeometry = true;
    const { features } = await stationLayer.queryFeatures(query);
    if (features[0]) await selectStation(features[0]);
  });
  const onSearch = () => searchStations();
  const onKey = (event) => { if (event.key === "Enter") searchStations(); };
  button.addEventListener("click", onSearch);
  input.addEventListener("keydown", onKey);
  app.onCleanup(() => { button.removeEventListener("click", onSearch); input.removeEventListener("keydown", onKey); panel.replaceChildren(); });
}
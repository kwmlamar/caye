# Property Intelligence v0.1

Caye's property model is a durable description of physical places and systems. It is not a device-control layer and it is not proof that a proposed physical intervention is safe.

## World model

The v0.1 hierarchy is:

- `physical_properties`: one workspace-scoped site/property
- `property_structures`: buildings or utility structures within a property
- `property_systems`: water, HVAC/thermal, energy/electrical, network, security, wastewater, structural, or other systems
- `property_assets`: physical components such as tanks, pumps, gutters, filters, AC units, routers, cameras, and panels
- `property_observations`: timestamped values/facts with explicit provenance
- `property_artifact_links`: semantic links to existing `business_artifacts`; images/PDFs are not duplicated

Every server write verifies the target property is in the current workspace. Structure, system, asset, source-artifact, and source-message references are additionally checked against the same property/workspace before persistence.

## Truth and provenance

Observations must remain distinguishable by source quality:

- `measured`: an actual measurement from an instrument or explicit measuring process
- `observed`: directly visible/observed state
- `operator_confirmed`: stated as fact by the authorized operator/founder
- `inferred`: derived from other evidence
- `estimated`: a planning approximation

An estimate must never silently become a measurement. Numeric observations require explicit units. Model output does not upgrade provenance.

## Engineering analysis

`analyze_property_water` is deterministic arithmetic, not a general hydraulic simulator. Its required inputs are explicit projected catchment area, rainfall depth, collection efficiency, storage capacity, starting storage, and daily demand. It computes captured volume, overflow, ending storage, and storage runway.

The calculation deliberately makes no claim about:

- potability or treatment safety
- pipe/downspout sizing
- pump/pressure-system adequacy
- structural safety
- future rainfall/weather
- code or regulatory compliance

Those require separate qualified analysis paths.

## Caye Direct presentation

A `property_snapshot` rich-result block is a semantic pointer to a property id. The browser never receives database credentials or storage URLs from that block. Rendering re-fetches the snapshot through a founder-authenticated API route that scopes the lookup to the active workspace. An invalid or foreign property id therefore renders as unavailable instead of exposing data.

## Relationship to artifacts and engineering jobs

- Property records describe what exists and what is known about it.
- `business_artifacts` hold source photos/PDFs/documents and remain the binary/document source of truth.
- `engineering_jobs` / `engineering_artifacts` represent generated design work such as CAD.
- `engineering_analysis_jobs` / analyses represent bounded solver output.
- None of these records is execution evidence that a real-world modification was performed.

## Explicitly deferred

Property Intelligence v0.1 does not include live IoT telemetry, automatic computer-vision measurement, weather forecasting, BIM, thermal/CFD simulation, hydraulic network solving, electrical load flow, automatic purchasing, contractor scheduling, or pump/valve/device actuation.

Future sensor ingestion should append provenance-aware observations or a dedicated telemetry stream without weakening workspace scoping. Future actuation requires a separate authority and execution architecture, not an extension of descriptive property memory.

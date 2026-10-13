# Research notes

Background research behind Deluge v2 (October 2026). Every number is tagged with how far it was checked:
**[V]** verified against a primary source, **[S]** secondary source, **[M]** from domain knowledge and still to be
verified, **[C]** computed, **[I]** illustrative assumption. Treat [M] and [I] values as placeholders until checked.

* [glacier-hazard-chain.md](glacier-hazard-chain.md) — glacial-lake outbursts, ice/rock avalanches, debris-flow
  rheology, 1-D valley routing, glacier melt, and case studies (Langtang/Betrawati 2026, Thame 2024, South Lhonak 2023,
  Chamoli 2021, Dig Tsho 1985, Gongbatongsha 2016, Blatten 2025). The design `src/hazard/` implements.
  [breach-check.mjs](breach-check.mjs) reproduces its breach-model table (`node docs/research/breach-check.mjs`).
* [climate-scenarios.md](climate-scenarios.md) — future-climate scenarios: AR6 warming by SSP and horizon,
  Clausius–Clapeyron and super-CC rain scaling, NOAA 2022 sea-level rise at Fort Myers, why river stages are not
  scaled, Himalayan glacial-lake growth and melt, and the Site check's today-vs-future EAL. The design `src/climate/`
  implements.
* [business-case.md](business-case.md) — market, competitors, loss modelling (JRC depth–damage curves, hazard
  classes, business interruption, expected annual loss, benefit–cost ratio), building valuation, product concept and
  pitch. The design `src/loss/` implements.

# Architecture Decision Records (ADR)

## 2026-07-22 — Project Naming

**Decision:** Name the project **ARC** (Architecture for Resilience & Continuity)

**Reasoning:**  
Short, strong, systemic. Works as both a word and an acronym. Avoids collision with Bryan Johnson’s “Blueprint” while capturing the OS / protocol / long-term resilience nature of the system.

---

## 2026-07-22 — Starting Tech Stack

**Decision:** Begin with Expo + React Native (TypeScript) + Supabase.

**Reasoning:**  
Maximum iteration speed while discovering the correct UX and data model. User already has strong Expo experience. AI coding tools currently perform better on this stack. Clean path to native SwiftUI later once the product is proven.

**Consequences:**  
- Faster earlying of home screen, coach, and core loops  
- Will eventually need a native port decision  
- HealthKit integration via Expo modules + possible custom native code later

---

## 2026-07-22 — Lab Strategy

**Decision:** Use Function Health as the primary comprehensive lab backend. Ingest via PDF download + structured parsing.

**Reasoning:**  
Best current combination of breadth (160+ biomarkers), quality, and accessibility. Avoids building phlebotomy/logistics. PDF parsing is reliable enough in 2026 with strong LLMs.

---

## 2026-07-22 — Home Screen Philosophy

**Decision:** The home screen is sacred and must remain ruthlessly directive. Full data exploration lives elsewhere.

**Reasoning:**  
The primary job of the app is to make the highest-leverage next action obvious. Information density is the enemy of daily execution.

---

## 2026-07-22 — Scoring System

**Decision:** Do not start with a single composite “Don’t Die Score.” Begin with multi-pillar status + clear actions. Revisit biological age / velocity later.

**Reasoning:**  
Composite scores force arbitrary weightings and can demotivate. Better to keep signals separate and let the Coach synthesize.

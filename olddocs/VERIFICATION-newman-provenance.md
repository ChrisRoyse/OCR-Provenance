# Verification: Newman Document Provenance
## United States v. Creeden
**Generated:** 2026-02-05
**Verification Agent:** Newman Provenance Validator
**Case:** United States v. Creeden (58A-KC-3426999)

---

## Verification Summary

| Metric | Count |
|--------|-------|
| Documents Verified | 3 |
| Provenance Chains Valid | 3 |
| SHA-256 Hashes Confirmed | 3 |
| Verification Failures | 0 |
| Quotes Located | 1 |

**OVERALL STATUS: PASS**

---

## Document Verification Results

### Document 1: January 11, 2024 Grand Jury Transcript

| Check | Status | Details |
|-------|--------|---------|
| Document Exists | PASS | Document found in database |
| Document ID Valid | PASS | `e62b2223-1972-4c3c-bdac-573ba2441c8f` |
| SHA-256 Hash Match | PASS | `sha256:13e250ab0a34a58ea98753b3278b3c9e96143db9f60077d43784aa8d0e51f513` |
| Provenance Chain Valid | PASS | Chain integrity verified |
| Content Integrity | PASS | Content hash verified against file |

**Document Details:**
- **File Name:** `2024_1_11_Creeden_Bill_jeremy_newman_grand_jury testimony_transcript.pdf`
- **File Path:** `/home/cabdru/datalab/fullcase/Creeden_Witness_Folders 1/Newman, Jeremy/2024_1_11_Creeden_Bill_jeremy_newman_grand_jury testimony_transcript.pdf`
- **File Size:** 8,179,688 bytes
- **Page Count:** 319
- **Status:** complete
- **Created:** 2026-02-05T04:18:12.562Z

**Provenance Chain:**
```
DOCUMENT (depth 0)
  ID: 290f5e10-956e-4e6f-80a2-a0aaea3d65df
  Processor: file-scanner v1.0.0
  Content Hash: sha256:13e250ab0a34a58ea98753b3278b3c9e96143db9f60077d43784aa8d0e51f513
```

**Verification Output:**
```json
{
  "item_id": "e62b2223-1972-4c3c-bdac-573ba2441c8f",
  "verified": true,
  "content_integrity": true,
  "chain_integrity": true
}
```

---

### Document 2: February 8, 2024 Grand Jury Transcript

| Check | Status | Details |
|-------|--------|---------|
| Document Exists | PASS | Document found in database |
| Document ID Valid | PASS | `41892dd8-19e2-40d4-a3ff-ee8f18b70071` |
| SHA-256 Hash Match | PASS | `sha256:44783670e99b53330b63745d8c999cf3769a87f1974ec80214576955647b7059` |
| Provenance Chain Valid | PASS | Chain integrity verified |
| Content Integrity | PASS | Content hash verified against file |

**Document Details:**
- **File Name:** `2024_2_8_Creeden_Bill_jeremy_newman_grand_jury testimony_transcript.pdf`
- **File Path:** `/home/cabdru/datalab/fullcase/Creeden_Witness_Folders 1/Newman, Jeremy/2024_2_8_Creeden_Bill_jeremy_newman_grand_jury testimony_transcript.pdf`
- **File Size:** 5,918,279 bytes
- **Page Count:** 229
- **Status:** complete
- **Created:** 2026-02-05T04:18:12.575Z

**Provenance Chain:**
```
DOCUMENT (depth 0)
  ID: 927b0549-a1e3-449b-b08c-05e717a15cab
  Processor: file-scanner v1.0.0
  Content Hash: sha256:44783670e99b53330b63745d8c999cf3769a87f1974ec80214576955647b7059
```

**Verification Output:**
```json
{
  "item_id": "41892dd8-19e2-40d4-a3ff-ee8f18b70071",
  "verified": true,
  "content_integrity": true,
  "chain_integrity": true
}
```

---

### Document 3: April 3, 2024 Grand Jury Transcript

| Check | Status | Details |
|-------|--------|---------|
| Document Exists | PASS | Document found in database |
| Document ID Valid | PASS | `157d416b-ced5-4c73-8c72-d3c10192077a` |
| SHA-256 Hash Match | PASS | `sha256:90d3367f0c3e4d8594c8fb5425fd8ba6d612efaaab69befd99c28753ebc11ef8` |
| Provenance Chain Valid | PASS | Chain integrity verified |
| Content Integrity | PASS | Content hash verified against file |

**Document Details:**
- **File Name:** `2024_04_03_Jeremy_Newman copy.pdf`
- **File Path:** `/home/cabdru/datalab/fullcase/Creeden_Witness_Folders 1/Newman, Jeremy/2024_04_03_Jeremy_Newman copy.pdf`
- **File Size:** 1,597,006 bytes
- **Page Count:** 58
- **Status:** complete
- **Created:** 2026-02-05T04:18:12.545Z

**Provenance Chain:**
```
DOCUMENT (depth 0)
  ID: d6be3c5b-bcfd-4d1a-a72b-8a7ed5cd822f
  Processor: file-scanner v1.0.0
  Content Hash: sha256:90d3367f0c3e4d8594c8fb5425fd8ba6d612efaaab69befd99c28753ebc11ef8
```

**Verification Output:**
```json
{
  "item_id": "157d416b-ced5-4c73-8c72-d3c10192077a",
  "verified": true,
  "content_integrity": true,
  "chain_integrity": true
}
```

---

## Quote Verification

### Quote: "I'm not an expert"

| Check | Status | Details |
|-------|--------|---------|
| Quote Found | PASS | Located in OCR text search |
| Source Document | PASS | `2024_1_11_Creeden_Bill_jeremy_newman_grand_jury testimony_transcript.pdf` |
| Document ID | `e62b2223-1972-4c3c-bdac-573ba2441c8f` |
| Chunk ID | `db23bc82-dfd7-40eb-9694-96234bb2db28` |
| Chunk Index | 10 |
| Character Range | 18,000 - 20,000 |

**Provenance Chain for Quote:**
```
CHUNK (depth 2)
  ID: ce25d492-618e-4230-8a10-72c9978648cf
  Processor: chunker
  Hash: sha256:f27e258cc9fc2083483c220cfb4f013ad4a74e9c5387d85bcc96639d06343f99
    |
    v
OCR_RESULT (depth 1)
  ID: 897e44f5-1f17-4408-b8af-29c0cc8640ce
  Processor: datalab-ocr
  Hash: sha256:4dbbee55b3c131441b95e87529129460f7440666471ea15fe33a70610d70ae30
    |
    v
DOCUMENT (depth 0)
  ID: 290f5e10-956e-4e6f-80a2-a0aaea3d65df
  Processor: file-scanner
  Hash: sha256:13e250ab0a34a58ea98753b3278b3c9e96143db9f60077d43784aa8d0e51f513
```

**Quote Context (Verbatim from OCR):**
```
Q. But what is a boilermaker?

A. A boilermaker.

Q. What is a carpenter? What is a plumber?
What is a boilermaker?

A. Right. So I'm not an expert on this but
I think the boilermakers conducts energy and they
work on those boilermakers. You know, they're
like welders going and maintain refineries.
```

---

## SHA-256 Hash Verification Summary

| Document | Claimed Hash | Verified Hash | Match |
|----------|--------------|---------------|-------|
| Newman GJ 1 (Jan 11) | `sha256:13e250ab0a34a58ea98753b3278b3c9e96143db9f60077d43784aa8d0e51f513` | `sha256:13e250ab0a34a58ea98753b3278b3c9e96143db9f60077d43784aa8d0e51f513` | PASS |
| Newman GJ 2 (Feb 8) | `sha256:44783670e99b53330b63745d8c999cf3769a87f1974ec80214576955647b7059` | `sha256:44783670e99b53330b63745d8c999cf3769a87f1974ec80214576955647b7059` | PASS |
| Newman GJ 3 (Apr 3) | `sha256:90d3367f0c3e4d8594c8fb5425fd8ba6d612efaaab69befd99c28753ebc11ef8` | `sha256:90d3367f0c3e4d8594c8fb5425fd8ba6d612efaaab69befd99c28753ebc11ef8` | PASS |

---

## W3C-PROV Export Reference

W3C PROV-compliant provenance data was exported for Document 1 (Jan 11 Grand Jury Transcript).

**Export Summary:**
- **Scope:** document
- **Format:** w3c-prov
- **Record Count:** 468 provenance entities
- **Context:** https://www.w3.org/ns/prov

**Sample W3C-PROV Entity:**
```json
{
  "@context": "https://www.w3.org/ns/prov",
  "entity": {
    "entity:290f5e10-956e-4e6f-80a2-a0aaea3d65df": {
      "prov:type": "DOCUMENT",
      "ocr:contentHash": "sha256:13e250ab0a34a58ea98753b3278b3c9e96143db9f60077d43784aa8d0e51f513",
      "ocr:chainDepth": 0
    }
  }
}
```

---

## Failed Verifications

**None.** All three Newman documents passed verification.

---

## Investigator Notes

Jeremy Newman is identified in case documents as a **United States Department of Labor Senior Investigator (SI)** who participated in numerous witness interviews alongside FBI Special Agents. He is referenced in multiple FBI 302 interview documents including:

- Mike Johnson interviews (2023-01-18, 2023-06-28, 2024-01-26)
- John Fultz interview (2023-06-20)
- Tyler Brown proffer (2024-03-04)
- James Cain interview (2023-04-14)
- Ashley Bathory interview (2024-02-02)
- Marina Conway interview (2023-01-23)

---

## Verification Methodology

1. **Document Existence:** Verified via `ocr_document_get` API call
2. **Hash Verification:** Compared stored hash against provenance chain hash
3. **Provenance Integrity:** Verified via `ocr_provenance_verify` with `verify_chain=true` and `verify_content=true`
4. **Quote Location:** Full-text search via `ocr_search_text` with provenance inclusion
5. **W3C-PROV Export:** Generated via `ocr_provenance_export` in w3c-prov format

---

**Report Generated:** 2026-02-05
**Verification Complete:** All Newman documents verified successfully

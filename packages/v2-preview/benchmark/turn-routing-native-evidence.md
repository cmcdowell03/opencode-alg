# PR17 native Luna turn-routing benchmark

Freeze SHA-256 `e25469cf1efe1e9132c1615e217dac5be0547d406c32e0c0955f915a0735e2c0`. Terminal report SHA-256 `155be2b2c0761be3c28e6d07789488fd85bf4504ae1a76698f32679d387a51d5`.

7/7 new arms attempted, 5 completed, and 4 passed the primary incident grade. Unsupported closure was observed in 0, and closure was unscorable in 2. The staged runtime remained unchanged `yes`.

The journal contains one run and 7 arm terminal receipts. Provider admissions and terminals number 248 and 248 with exact pairing yes.

Willow uses two hash-verified historical controls. Birch and Larch are same-run paired comparisons. The primary grade accepts recognized aliases, repeated supported targets, and extra references to existing rows from verified root reads. Blind review is a separate endpoint. The samples and traces describe these runs. Model choices can mediate any treatment effect.

## Per-arm results

| Case | Arm | Terminal outcome | Incident pass | Disposition | Unsupported closure | Bridge method / seal / units | Duplicate reads | Autos applied / complete | Input total / all peak / root peak | Usage rows |
| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| Willow Yard | Build (historical) | complete | no | indeterminate | no | yes / yes / yes | 4 | 3 / 3 | 92,413 / 7,378 / 6,803 | 22 / 22 |
| Willow Yard | Focused Build (historical) | complete | no | indeterminate | no | yes / yes / yes | 2 | 3 / 3 | 104,530 / 7,379 / 6,804 | 31 / 31 |
| Willow Yard | Routed compact ALG | complete | no | indeterminate | no | yes / yes / yes | 6 | 8 / 8 | 204,488 / 7,149 / 6,771 | 48 / 48 |
| Birch Siding | Focused Build | complete | yes | resolved | no | yes / yes / yes | 3 | 3 / 3 | 123,700 / 7,474 / 6,875 | 37 / 37 |
| Birch Siding | Routed compact ALG | early-stop (`NATIVE_PROVIDER_CALL_BUDGET`) | no | — | — | yes / yes / yes | 1 | 10 / 10 | 202,690 / 7,433 / 6,918 | 48 / 48 |
| Birch Siding | Build | complete | yes | resolved | no | yes / yes / yes | 2 | 3 / 3 | 90,741 / 7,539 / 6,944 | 20 / 20 |
| Larch Depot | Routed compact ALG | early-stop (`NATIVE_PROVIDER_CALL_BUDGET`) | no | — | — | yes / yes / yes | 1 | 10 / 10 | 207,172 / 7,346 / 6,823 | 48 / 48 |
| Larch Depot | Build | complete | yes | indeterminate | no | yes / yes / yes | 3 | 3 / 3 | 95,716 / 7,449 / 6,848 | 22 / 22 |
| Larch Depot | Focused Build | complete | yes | indeterminate | no | yes / yes / yes | 2 | 3 / 3 | 103,390 / 7,440 / 6,841 | 25 / 25 |

Observed input tokens include cached input. The configured root context was 8,192 tokens. The new arms had 0 observed manual boundaries. A missing final fails primary accuracy and leaves closure unscorable.

## Routing and evidence receipts

| Case | Arm | ALG calls | Supported early calibration writes | Attested bridge readbacks / prior catalog | Approved procedure receipts | Skill body on bridge wire | Seal on bridge wire | Bridge registry rereads | Graph requests in staging / bridge | Schema bytes / active bytes |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: |
| Willow Yard | Routed compact ALG | 18 | 0 | 0 / 0 | 1 | developer, tool | graph status | 0 | 0 / 0 | 87,168 / 69,496 |
| Birch Siding | Focused Build | 0 | 0 | 0 / 0 | 0 | user | source | 1 | 0 / 0 | 0 / 0 |
| Birch Siding | Routed compact ALG | 19 | 0 | 0 / 0 | 1 | developer, tool | graph status | 0 | 0 / 0 | 101,854 / 84,388 |
| Birch Siding | Build | 0 | 0 | 0 / 0 | 0 | user | none verified | 1 | 0 / 0 | 0 / 0 |
| Larch Depot | Routed compact ALG | 18 | 0 | 0 / 0 | 1 | developer, tool | graph status | 0 | 0 / 0 | 92,965 / 74,460 |
| Larch Depot | Build | 0 | 0 | 0 / 0 | 0 | user | none verified | 1 | 0 / 0 | 0 / 0 |
| Larch Depot | Focused Build | 0 | 0 | 0 / 0 | 0 | user | none verified | 1 | 0 / 0 | 0 / 0 |

An attested readback matches labeled calibration values and links to the exact prior root-read row. Catalog credit requires a separate earlier response visible on the bridge wire. Active schema bytes count schemas offering a recording action.

Routed compact ALG produced correct bridge conversions in 3/3 arms. A runtime-verified status result carried the seal on the final post-boundary bridge request in 3/3 correct conversions. The applied summary carried the seal in 0/3 and verified registry payload in 0/3. The stricter catalog-to-selected-finding attestation held in 0/3.

## Final-turn input spend

Ordinary root requests accounted for 153,599 of 210,549 routed final-turn input tokens (73%). Auto-compaction summaries accounted for the remaining 56,950. Each routed arm issued repeated status lookups and evidence reads during final. The traces establish where the tokens were spent and leave causal attribution between routing and model behavior unresolved.

| Case | Arm | Ordinary requests / input tokens | Summary requests / input tokens | Status calls | Source reads |
| --- | --- | ---: | ---: | ---: | ---: |
| Willow Yard | Routed compact ALG | 10 / 46,084 | 4 / 17,410 | 4 | 11 |
| Birch Siding | Focused Build | 4 / 18,852 | 0 / 0 | 0 | 3 |
| Birch Siding | Routed compact ALG | 13 / 57,445 | 6 / 21,825 | 6 | 7 |
| Birch Siding | Build | 3 / 10,239 | 0 / 0 | 0 | 7 |
| Larch Depot | Routed compact ALG | 11 / 50,070 | 5 / 17,715 | 6 | 7 |
| Larch Depot | Build | 4 / 13,627 | 0 / 0 | 0 | 7 |
| Larch Depot | Focused Build | 4 / 15,804 | 0 / 0 | 0 | 7 |

## Turn-level tool actions and schema bytes

Cells show root or checker calls by action and provider schema bytes as total / active. Zero indicates an observed turn without calls or schema. — indicates an unobserved turn.

| Arm | Triage | Batch 1 | Batch 2 | Batch 3 | Batch 4 | Batch 5 | Batch 6 | Bridge | Checker | Final |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Willow Yard · Routed compact ALG | skill×1, create×1, list×1, read×1, status×2, record_finding×2<br>31,656 / 29,784 | 0<br>936 / 0 | status×1<br>1,975 / 0 | status×2<br>3,014 / 0 | status×1<br>1,975 / 0 | 0<br>936 / 0 | status×1, skill×1<br>3,014 / 0 | procedure×1, status×1<br>1,975 / 0 | list×2, read×6<br>0 / 0 | status×4, list×3, create×1, read×11, record_finding×1<br>41,687 / 39,712 |
| Birch Siding · Focused Build | skill×1, list×1, read×1<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | skill×1, list×1, read×1<br>0 / 0 | list×7, read×7<br>0 / 0 | read×3<br>0 / 0 |
| Birch Siding · Routed compact ALG | skill×1, create×1, procedure×1, list×1, status×2, read×1, record_finding×2<br>35,684 / 34,748 | status×1<br>1,975 / 0 | 0<br>936 / 0 | status×1<br>1,975 / 0 | 0<br>936 / 0 | status×1<br>1,975 / 0 | 0<br>936 / 0 | skill×1, status×2, procedure×1<br>4,989 / 0 | list×1, read×7<br>0 / 0 | skill×3, create×1, list×1, status×6, read×7<br>52,448 / 49,640 |
| Birch Siding · Build | skill×1, list×1, read×1<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | skill×1, list×1, read×1<br>0 / 0 | — | skill×1, list×1, read×7<br>0 / 0 |
| Larch Depot · Routed compact ALG | skill×1, create×1, list×1, read×1, status×2, record_finding×1<br>31,656 / 29,784 | skill×1, status×1<br>2,911 / 0 | 0<br>936 / 0 | status×1<br>1,975 / 0 | 0<br>936 / 0 | status×1<br>1,975 / 0 | status×2<br>3,014 / 0 | procedure×1, status×1<br>3,014 / 0 | list×2, read×7<br>0 / 0 | create×1, status×6, list×1, read×7<br>46,548 / 44,676 |
| Larch Depot · Build | skill×1, list×1, read×2<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | skill×1, list×1, read×2<br>0 / 0 | — | skill×1, list×1, read×7<br>0 / 0 |
| Larch Depot · Focused Build | skill×1, list×1, read×1<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | 0<br>0 / 0 | skill×1, list×1, read×1<br>0 / 0 | list×1, read×7<br>0 / 0 | skill×1, list×1, read×7<br>0 / 0 |

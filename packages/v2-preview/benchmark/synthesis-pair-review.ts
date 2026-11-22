import { synthesisPairCases, synthesisPairChange, synthesisPairChangeNotice } from "./synthesis-pair-cases.ts"
import { runTurnRoutingReview } from "./turn-routing-review.ts"

if (import.meta.main) await runTurnRoutingReview(process.argv.slice(2), {
  cases: synthesisPairCases, conditionalReplacement: { ...synthesisPairChange, notice: synthesisPairChangeNotice },
})

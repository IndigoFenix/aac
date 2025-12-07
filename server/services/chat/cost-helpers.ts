export const CREDITS_PER_WEB_SEARCH = 2;

const ORIGNAL_DOLLARS_PER_CREDIT = 0.00026;
const PROFIT_MARGIN = 1.3;
const DOLLARS_PER_CREDIT = ORIGNAL_DOLLARS_PER_CREDIT / PROFIT_MARGIN;

const MILLION = 1000000;

const ChargeToCredits = (charge: number) => {
    return charge / DOLLARS_PER_CREDIT;
}

export const CreditsPerPromptTokenByIntelligence = (intelligence: number) => {
    if (intelligence === 2){
        return ChargeToCredits(2.50 / MILLION);
    } else if (intelligence === 3){
        return ChargeToCredits(20 / MILLION);
    } else {
        return ChargeToCredits(0.15 / MILLION);
    }
}
export const CreditsPerCompletionTokenByIntelligence = (intelligence: number) => {
    if (intelligence === 2){
        return ChargeToCredits(10 / MILLION);
    } else if (intelligence === 3){
        return ChargeToCredits(80 / MILLION);
    } else {
        return ChargeToCredits(0.60 / MILLION);
    }
}
// original cost in dollars / 150

// number of credits to charge for ONE web_search_preview tool call
export const CreditsPerSearchByIntelligence = (
    intelligence: 0|1|2|3,           // 0 = mini, 1 = mini, 2 = 4o, 3 = o3-pro
    contextSize: 1|2|3               // 1=low  2=med  3=high
  ) => {
    if (intelligence === 0) intelligence = 1;
    // $ surcharge per call from OpenAI’s table  (Jul-2025)
    const surchargeUSD = {
      1: [0.003, 0.006, 0.012],      // 4o-mini-search
      2: [0.03 , 0.06 , 0.12 ],      // 4o-search
      3: [0.06 , 0.12 , 0.24 ]       // o3-pro, same ×2 guess until OpenAI posts
    }[intelligence][contextSize-1];
  
    return ChargeToCredits(surchargeUSD);
  };
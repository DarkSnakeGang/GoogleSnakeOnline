const s =
  "indexOf(document.querySelector('#count').getElementsByClassName('tuJOWd')[0]))>3";
const re =
  /(indexOf\(document\.querySelector\('#count'\)\.getElementsByClassName\('tuJOWd'\)\[0\]\)\)\s*>\s*)3/;
console.log("with $16:", JSON.stringify(s.replace(re, "$16")));
console.log("with fn:", JSON.stringify(s.replace(re, (m, g1) => g1 + "6")));
console.log("match", s.match(re));

// Simulate if MorePudding has slightly different spacing
const samples = [
  s,
  "indexOf(document.querySelector('#count').getElementsByClassName('tuJOWd')[0])) > 3",
  "foo,indexOf(document.querySelector('#count').getElementsByClassName('tuJOWd')[0]))>3,bar",
];
for (const sample of samples) {
  console.log("---");
  console.log("in:", sample);
  console.log("out:", sample.replace(re, "$16"));
}

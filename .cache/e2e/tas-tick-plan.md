# Bomb Small tick plan

- goal: 84
- ticks: 58 (max 60)
- bands: A=right B=left

```
t=0 faceA=RIGHT faceB=RIGHT apples=1 total=0 [boot]
  0123456789
0 ..........
1 ..........
2 ..........
3 ...aaA....
4 .......@..
5 ...bbB....
6 ..........
7 ..........
8 ..........
```

```
t=1 faceA=RIGHT faceB=UP dirA=RIGHT dirB=UP apples=1 total=0 [approach]
  0123456789
0 ..........
1 ..........
2 ..........
3 ....aaA...
4 .....B.@..
5 ....bb....
6 ..........
7 ..........
8 ..........
```

```
t=2 faceA=RIGHT faceB=UP dirA=RIGHT dirB=UP apples=1 total=0 [approach]
  0123456789
0 ..........
1 ..........
2 ..........
3 .....BaA..
4 .....b.@..
5 .....b....
6 ..........
7 ..........
8 ..........
```

```
t=3 faceA=DOWN faceB=UP dirA=DOWN dirB=UP apples=24 total=1 eats=A [bomb24-place]
  0123456789
0 .....@@@@@
1 ...@...@@@
2 .....B.@@@
3 .....baa@@
4 .....b.A@@
5 ........@@
6 ........@@
7 ........@@
8 ........@@
```

```
t=4 faceA=RIGHT faceB=LEFT dirA=RIGHT dirB=LEFT apples=24 total=1 [enter]
  0123456789
0 .....@@@@@
1 ...@...@@@
2 ....Bb.@@@
3 .....baa@@
4 .......aA@
5 ........@@
6 ........@@
7 ........@@
8 ........@@
```

```
t=5 faceA=DOWN faceB=LEFT dirA=DOWN dirB=LEFT apples=24 total=1 [enter]
  0123456789
0 .....@@@@@
1 ...@...@@@
2 ...Bbb.@@@
3 .......a@@
4 .......aa@
5 ........A@
6 ........@@
7 ........@@
8 ........@@
```

```
t=6 faceA=DOWN faceB=UP dirA=DOWN dirB=UP apples=24 total=3 eats=A+B [cover-eat]
  0123456789
0 ...@@@@@@@
1 ...B@....@
2 ...bbb...@
3 ....@..a.@
4 ....@..aa@
5 ....@...a@
6 ....@...A@
7 ....@...@@
8 ....@...@@
```

```
t=7 faceA=DOWN faceB=UP dirA=DOWN dirB=UP apples=24 total=5 eats=A+B [cover-eat]
  0123456789
0 ..@B@@@@@@
1 ...b@....@
2 ...bbb...@
3 ....@..a.@
4 ....@..aa@
5 ....@...a@
6 ....@...a@
7 ....@...A@
8 ....@@..@@
```

```
t=8 faceA=DOWN faceB=LEFT dirA=DOWN dirB=LEFT apples=24 total=7 eats=A+B [cover-eat]
  0123456789
0 .@Bb@@@@@@
1 ...b@....@
2 ...bbb...@
3 ....@..a.@
4 ....@..aa@
5 ....@...a@
6 ....@...a@
7 ....@@..a@
8 ....@@..A@
```

```
t=9 faceA=RIGHT faceB=LEFT dirA=RIGHT dirB=LEFT apples=24 total=9 eats=A+B [cover-eat]
  0123456789
0 @Bbb@@@@@@
1 ...b@....@
2 ...bbb...@
3 ....@..a.@
4 ....@..aa@
5 ....@...a@
6 ....@@..a@
7 ....@@..a@
8 ....@@..aA
```

```
t=10 faceA=UP faceB=LEFT dirA=UP dirB=LEFT apples=24 total=11 eats=A+B [cover-eat]
  0123456789
0 Bbbb@@@@@@
1 @..b@....@
2 ...bbb...@
3 ....@..a.@
4 ....@..aa@
5 ....@@..a@
6 ....@@..a@
7 ....@@..aA
8 ....@@..aa
```

```
t=11 faceA=UP faceB=DOWN dirA=UP dirB=DOWN apples=24 total=13 eats=A+B [cover-eat]
  0123456789
0 bbbb@@@@@@
1 B..b@....@
2 @..bbb...@
3 ....@..a.@
4 ....@@.aa@
5 ....@@..a@
6 ....@@..aA
7 ....@@..aa
8 ....@@..aa
```

```
t=12 faceA=UP faceB=DOWN dirA=UP dirB=DOWN apples=24 total=15 eats=A+B [cover-eat]
  0123456789
0 bbbb@@@@@@
1 b..b@....@
2 B..bbb...@
3 @...@@.a.@
4 ....@@.aa@
5 ....@@..aA
6 ....@@..aa
7 ....@@..aa
8 ....@@..aa
```

```
t=13 faceA=UP faceB=DOWN dirA=UP dirB=DOWN apples=24 total=17 eats=A+B [cover-eat]
  0123456789
0 bbbb@@@@@@
1 b..b@@...@
2 b..bbb...@
3 B...@@.a.@
4 @...@@.aaA
5 ....@@..aa
6 ....@@..aa
7 ....@@..aa
8 ....@@..aa
```

```
t=14 faceA=UP faceB=DOWN dirA=UP dirB=DOWN apples=24 total=19 eats=A+B [cover-eat]
  0123456789
0 bbbb@@@@@@
1 b..b@@@..@
2 b..bbb...@
3 b...@@.a.A
4 B...@@.aaa
5 @...@@..aa
6 ....@@..aa
7 ....@@..aa
8 ....@@..aa
```

```
t=15 faceA=UP faceB=DOWN dirA=UP dirB=DOWN apples=24 total=21 eats=A+B [cover-eat]
  0123456789
0 bbbb@@@@@@
1 b..b@@@..@
2 b..bbb@..A
3 b...@@.a.a
4 b...@@.aaa
5 B...@@..aa
6 @...@@..aa
7 ....@@..aa
8 ....@@..aa
```

```
t=16 faceA=UP faceB=DOWN dirA=UP dirB=DOWN apples=24 total=23 eats=A+B [cover-eat]
  0123456789
0 bbbb@@@@@@
1 b..b@@@..A
2 b..bbb@..a
3 b...@@@a.a
4 b...@@.aaa
5 b...@@..aa
6 B...@@..aa
7 @...@@..aa
8 ....@@..aa
```

```
t=17 faceA=UP faceB=DOWN dirA=UP dirB=DOWN apples=24 total=25 eats=A+B [cover-eat]
  0123456789
0 bbbb@@@@@A
1 b..b@@@..a
2 b..bbb@..a
3 b...@@@a.a
4 b...@@@aaa
5 b...@@..aa
6 b...@@..aa
7 B...@@..aa
8 @...@@..aa
```

```
t=18 faceA=LEFT faceB=DOWN dirA=LEFT dirB=DOWN apples=24 total=27 eats=A+B [cover-eat]
  0123456789
0 bbbb@@@@Aa
1 b..b@@@..a
2 b..bbb@..a
3 b...@@@a.a
4 b...@@@aaa
5 b...@@@.aa
6 b...@@..aa
7 b...@@..aa
8 B@..@@..aa
```

```
t=19 faceA=LEFT faceB=RIGHT dirA=LEFT dirB=RIGHT apples=24 total=29 eats=A+B [cover-eat]
  0123456789
0 bbbb@@@Aaa
1 b..b@@@..a
2 b..bbb@..a
3 b...@@@a.a
4 b...@@@aaa
5 b...@@@.aa
6 b...@@@.aa
7 b@..@@..aa
8 bB..@@..aa
```

```
t=20 faceA=LEFT faceB=UP dirA=LEFT dirB=UP apples=24 total=31 eats=A+B [cover-eat]
  0123456789
0 bbbb@@Aaaa
1 b..b@@@..a
2 b..bbb@..a
3 b...@@@a.a
4 b...@@@aaa
5 b...@@@.aa
6 b@..@@@.aa
7 bB..@@@.aa
8 bb..@@..aa
```

```
t=21 faceA=LEFT faceB=UP dirA=LEFT dirB=UP apples=24 total=33 eats=A+B [cover-eat]
  0123456789
0 bbbb@Aaaaa
1 b..b@@@..a
2 b..bbb@..a
3 b...@@@a.a
4 b...@@@aaa
5 b@..@@@.aa
6 bB..@@@.aa
7 bb..@@@.aa
8 bb..@@@.aa
```

```
t=22 faceA=LEFT faceB=UP dirA=LEFT dirB=UP apples=24 total=35 eats=A+B [cover-eat]
  0123456789
0 bbbbAaaaaa
1 b..b@@@..a
2 b..bbb@..a
3 b...@@@a.a
4 b@..@@@aaa
5 bB..@@@.aa
6 bb..@@@.aa
7 bb..@@@.aa
8 bb..@@@@aa
```

```
t=23 faceA=DOWN faceB=UP dirA=DOWN dirB=UP apples=24 total=37 eats=A+B [cover-eat]
  0123456789
0 bbbbaaaaaa
1 b..bA@@..a
2 b..bbb@..a
3 b@..@@@a.a
4 bB..@@@aaa
5 bb..@@@.aa
6 bb..@@@.aa
7 bb..@@@@aa
8 bb..@@@@aa
```

```
t=24 faceA=DOWN faceB=UP dirA=DOWN dirB=UP apples=24 total=38 eats=B [cover-eat]
  0123456789
0 bbbbaaaaaa
1 b..ba@@..a
2 b@.bbb@..a
3 bB..@@@..a
4 bb..@@@aaa
5 bb..@@@.aa
6 bb..@@@.aa
7 bb..@@@@aa
8 bb..@@@@aa
```

```
t=25 faceA=DOWN faceB=UP dirA=DOWN dirB=UP apples=24 total=40 eats=A+B [cover-eat]
  0123456789
0 bbbbaaaaaa
1 b@.ba@@..a
2 bB.bbb@..a
3 bb..A@@..a
4 bb..@@@aaa
5 bb..@@@.aa
6 bb..@@@@aa
7 bb..@@@@aa
8 bb..@@@@aa
```

```
t=26 faceA=DOWN faceB=UP dirA=DOWN dirB=UP apples=24 total=42 eats=A+B [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bB@ba@@..a
2 bb.bbb@..a
3 bb..a@@..a
4 bb..A@@aaa
5 bb..@@@@aa
6 bb..@@@@aa
7 bb..@@@@aa
8 bb..@@@@aa
```

```
t=27 faceA=DOWN faceB=RIGHT dirA=DOWN dirB=RIGHT apples=24 total=44 eats=A+B [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbBba@@..a
2 bb@bbb@..a
3 bb..a@@@.a
4 bb..a@@aaa
5 bb..A@@@aa
6 bb..@@@@aa
7 bb..@@@@aa
8 bb..@@@@aa
```

```
t=28 faceA=DOWN faceB=DOWN dirA=DOWN dirB=DOWN apples=24 total=46 eats=A+B [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbba@@..a
2 bbBbbb@@.a
3 bb@.a@@@.a
4 bb..a@@aaa
5 bb..a@@@aa
6 bb..A@@@aa
7 bb..@@@@aa
8 bb..@@@@aa
```

```
t=29 faceA=DOWN faceB=DOWN dirA=DOWN dirB=DOWN apples=24 total=48 eats=A+B [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbba@@@.a
2 bbbbbb@@.a
3 bbB.a@@@.a
4 bb@.a@@aaa
5 bb..a@@@aa
6 bb..a@@@aa
7 bb..A@@@aa
8 bb..@@@@aa
```

```
t=30 faceA=DOWN faceB=DOWN dirA=DOWN dirB=DOWN apples=24 total=50 eats=A+B [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbba@@@@a
2 bbbbbb@@.a
3 bbb.a@@@.a
4 bbB.a@@aaa
5 bb@.a@@@aa
6 bb..a@@@aa
7 bb..a@@@aa
8 bb..A@@@aa
```

```
t=31 faceA=RIGHT faceB=DOWN dirA=RIGHT dirB=DOWN apples=24 total=52 eats=A+B [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbba@@@@a
2 bbbbbb@@@a
3 bbb.a@@@.a
4 bbb.a@@aaa
5 bbB.a@@@aa
6 bb@.a@@@aa
7 bb..a@@@aa
8 bb..aA@@aa
```

```
t=32 faceA=UP faceB=DOWN dirA=UP dirB=DOWN apples=24 total=54 eats=A+B [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbba@@@@a
2 bbbbbb@@@a
3 bbb.a@@@@a
4 bbb.a@@aaa
5 bbb.a@@@aa
6 bbB.a@@@aa
7 bb@.aA@@aa
8 bb..aa@@aa
```

```
t=33 faceA=UP faceB=DOWN dirA=UP dirB=DOWN apples=24 total=56 eats=A+B [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbba@@@@a
2 bbbbbb@@@a
3 bbb.a@@@@a
4 bbb.a@@aaa
5 bbb.a@@@aa
6 bbb.aA@@aa
7 bbB.aa@@aa
8 bb@@aa@@aa
```

```
t=34 faceA=UP faceB=DOWN dirA=UP dirB=DOWN apples=24 total=58 eats=A+B [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbba@@@@a
2 bbbbbb@@@a
3 bbb.a@@@@a
4 bbb.a@@aaa
5 bbb.aA@@aa
6 bbb@aa@@aa
7 bbb@aa@@aa
8 bbB@aa@@aa
```

```
t=35 faceA=UP faceB=RIGHT dirA=UP dirB=RIGHT apples=24 total=60 eats=A+B [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbba@@@@a
2 bbbbbb@@@a
3 bbb.a@@@@a
4 bbb@aA@aaa
5 bbb@aa@@aa
6 bbb@aa@@aa
7 bbb@aa@@aa
8 bbbBaa@@aa
```

```
t=36 faceA=UP faceB=UP dirA=UP dirB=UP apples=22 total=62 eats=A+B [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbba@@@@a
2 bbbbbb@@@a
3 bbb.aA@@@a
4 bbb@aa@aaa
5 bbb@aa@@aa
6 bbb@aa@@aa
7 bbbBaa@@aa
8 bbbbaa@@aa
```

```
t=37 faceA=UP faceB=UP dirA=UP dirB=UP apples=21 total=63 eats=B [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbba@@@@a
2 bbbbbb@@@a
3 bbb.aa@@@a
4 bbb.aa@@aa
5 bbb@aa@@aa
6 bbbBaa@@aa
7 bbbbaa@@aa
8 bbbbaa@@aa
```

```
t=38 faceA=UP faceB=UP dirA=UP dirB=UP apples=19 total=65 eats=A+B [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbbaA@@@a
2 bbbbbb@@@a
3 bbb.aa@@@a
4 bbb.aa@@aa
5 bbbBaa@@aa
6 bbbbaa@@aa
7 bbbbaa@@aa
8 bbbbaa@@aa
```

```
t=39 faceA=RIGHT faceB=UP dirA=RIGHT dirB=UP apples=18 total=66 eats=A [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbbaaA@@a
2 bbbbba@@@a
3 bbb.aa@@@a
4 bbbBaa@@aa
5 bbbbaa@@aa
6 bbbbaa@@aa
7 bbbbaa@@aa
8 bbbbaa@@aa
```

```
t=40 faceA=DOWN faceB=UP dirA=DOWN dirB=UP apples=17 total=67 eats=A [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbbaaa@@a
2 bbbbaaA@@a
3 bbbBaa@@@a
4 bbbbaa@@aa
5 bbbbaa@@aa
6 bbbbaa@@aa
7 bbbbaa@@aa
8 bbbbaa@@aa
```

```
t=41 faceA=DOWN faceB=UP dirA=DOWN dirB=UP apples=16 total=68 eats=A [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbbaaa@@a
2 bbbBaaa@@a
3 bbbbaaA@@a
4 bbbbaa@@aa
5 bbbbaa@@aa
6 bbbbaa@@aa
7 bbbbaa@@aa
8 bbbbaa@@aa
```

```
t=42 faceA=DOWN faceB=UP dirA=DOWN dirB=UP apples=15 total=69 eats=A [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbBaaa@@a
2 bbbbaaa@@a
3 bbbbaaa@@a
4 bbbbaaA@aa
5 bbbbaa@@aa
6 bbbbaa@@aa
7 bbbbaa@@aa
8 bbbbaa@@aa
```

```
t=43 faceA=DOWN faceB=UP dirA=DOWN dirB=UP apples=14 total=70 eats=A [cover-eat]
  0123456789
0 bbbBaaaaaa
1 bbbbaaa@@a
2 bbbbaaa@@a
3 bbbbaaa@@a
4 bbbbaaa@aa
5 bbbbaaA@aa
6 bbbbaa@@aa
7 bbbbaa@@aa
8 bbbbaa@@aa
```

```
t=44 faceA=DOWN faceB=LEFT dirA=DOWN dirB=LEFT apples=13 total=71 eats=A [cover-eat]
  0123456789
0 bbBbaaaaaa
1 bbbbaaa@@a
2 bbbbaaa@@a
3 bbbbaaa@@a
4 bbbbaaa@aa
5 bbbbaaa@aa
6 bbbbaaA@aa
7 bbbbaa@@aa
8 bbbbaa@@aa
```

```
t=45 faceA=DOWN faceB=LEFT dirA=DOWN dirB=LEFT apples=12 total=72 eats=A [cover-eat]
  0123456789
0 bBbbaaaaaa
1 bbbbaaa@@a
2 bbbbaaa@@a
3 bbbbaaa@@a
4 bbbbaaa@aa
5 bbbbaaa@aa
6 bbbbaaa@aa
7 bbbbaaA@aa
8 bbbbaa@@aa
```

```
t=46 faceA=DOWN faceB=LEFT dirA=DOWN dirB=LEFT apples=11 total=73 eats=A [cover-eat]
  0123456789
0 Bbbbaaaaaa
1 bbbbaaa@@a
2 bbbbaaa@@a
3 bbbbaaa@@a
4 bbbbaaa@aa
5 bbbbaaa@aa
6 bbbbaaa@aa
7 bbbbaaa@aa
8 bbbbaaA@aa
```

```
t=47 faceA=RIGHT faceB=DOWN dirA=RIGHT dirB=DOWN apples=10 total=74 eats=A [cover-eat]
  0123456789
0 bbbbaaaaaa
1 Bbbbaaa@@a
2 bbbbaaa@@a
3 bbbbaaa@@a
4 bbbbaaa@aa
5 bbbbaaa@aa
6 bbbbaaa@aa
7 bbbbaaa@aa
8 bbbbaaaAaa
```

```
t=48 faceA=UP faceB=DOWN dirA=UP dirB=DOWN apples=9 total=75 eats=A [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbbaaa@@a
2 Bbbbaaa@@a
3 bbbbaaa@@a
4 bbbbaaa@aa
5 bbbbaaa@aa
6 bbbbaaa@aa
7 bbbbaaaAaa
8 bbbbaaaaaa
```

```
t=49 faceA=UP faceB=DOWN dirA=UP dirB=DOWN apples=8 total=76 eats=A [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbbaaa@@a
2 bbbbaaa@@a
3 Bbbbaaa@@a
4 bbbbaaa@aa
5 bbbbaaa@aa
6 bbbbaaaAaa
7 bbbbaaaaaa
8 bbbbaaaaaa
```

```
t=50 faceA=UP faceB=DOWN dirA=UP dirB=DOWN apples=7 total=77 eats=A [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbbaaa@@a
2 bbbbaaa@@a
3 bbbbaaa@@a
4 Bbbbaaa@aa
5 bbbbaaaAaa
6 bbbbaaaaaa
7 bbbbaaaaaa
8 bbbbaaaaaa
```

```
t=51 faceA=UP faceB=DOWN dirA=UP dirB=DOWN apples=6 total=78 eats=A [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbbaaa@@a
2 bbbbaaa@@a
3 bbbbaaa@@a
4 bbbbaaaAaa
5 Bbbbaaaaaa
6 bbbbaaaaaa
7 bbbbaaaaaa
8 bbbbaaaaaa
```

```
t=52 faceA=UP faceB=DOWN dirA=UP dirB=DOWN apples=5 total=79 eats=A [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbbaaa@@a
2 bbbbaaa@@a
3 bbbbaaaA@a
4 bbbbaaaaaa
5 bbbbaaaaaa
6 Bbbbaaaaaa
7 bbbbaaaaaa
8 bbbbaaaaaa
```

```
t=53 faceA=UP faceB=DOWN dirA=UP dirB=DOWN apples=4 total=80 eats=A [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbbaaa@@a
2 bbbbaaaA@a
3 bbbbaaaa@a
4 bbbbaaaaaa
5 bbbbaaaaaa
6 bbbbaaaaaa
7 Bbbbaaaaaa
8 bbbbaaaaaa
```

```
t=54 faceA=UP faceB=DOWN dirA=UP dirB=DOWN apples=3 total=81 eats=A [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbbaaaA@a
2 bbbbaaaa@a
3 bbbbaaaa@a
4 bbbbaaaaaa
5 bbbbaaaaaa
6 bbbbaaaaaa
7 bbbbaaaaaa
8 Bbbbaaaaaa
```

```
t=55 faceA=RIGHT faceB=RIGHT dirA=RIGHT dirB=RIGHT apples=2 total=82 eats=A [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbbaaaaAa
2 bbbbaaaa@a
3 bbbbaaaa@a
4 bbbbaaaaaa
5 bbbbaaaaaa
6 bbbbaaaaaa
7 bbbbaaaaaa
8 bBbbaaaaaa
```

```
t=56 faceA=DOWN faceB=UP dirA=DOWN dirB=UP apples=1 total=83 eats=A [cover-eat]
  0123456789
0 bbbbaaaaaa
1 bbbbaaaaaa
2 bbbbaaaaAa
3 bbbbaaaa@a
4 bbbbaaaaaa
5 bbbbaaaaaa
6 bbbbaaaaaa
7 bBbbaaaaaa
8 bbbbaaaaaa
```

```
t=57 faceA=DOWN faceB=UP dirA=DOWN dirB=UP apples=0 total=84 eats=A [win]
  0123456789
0 bbbbaaaaaa
1 bbbbaaaaaa
2 bbbbaaaaaa
3 bbbbaaaaAa
4 bbbbaaaaaa
5 bbbbaaaaaa
6 bBbbaaaaaa
7 bbbbaaaaaa
8 bbbbaaaaaa
```

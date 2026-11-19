# Why the official PL differed from the tool

`pl_reasons.csv` holds one line per day when the official Southwest PL (NICC) wasn't the PL this tool gave.
The Data Health tab on the site lists those days and links here.

To add a reason on GitHub: open `pl_reasons.csv`, click the pencil icon, add a line, and **Commit changes**:

```
date,official_pl,tool_pl,reason,entered_by
2027-06-03,3,2,"Two Type 1 IMTs committed out of area; holding PL3 for the holiday weekend",KC
```

Use quotes around a reason that has a comma in it. The scheduled job never writes this file, so it never
overwrites what people enter. The reasons show on the Data Health tab, the History calendar and Season Review,
and go into the Season Review Excel download.

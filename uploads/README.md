# ERC / BI uploads

Upload the day's ERC and BI file here (**Add file → Upload files** on GitHub). The site picks it up
within a few minutes and uses it for everyone; the newest file in this folder wins.

Accepted: `.xlsx` or `.csv` with a PSA column (SW01 … SW14N, or SW-01 …) and any of these columns:
ERCy value, ERCy percentile, BI value, BI percentile, and an observation date. Headers like
`PSA Avg | ERCy Avg | BI Avg | ERCy Percentile | BI Percentile | ObsDate` work as they are.
Several rows per PSA (one per station) are averaged, using each PSA's latest date.

You can also upload the file on the site itself (PSA ERCy tab → Upload ERC/BI file); that only
changes the copy in your own browser.

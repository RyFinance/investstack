"""Write the Inbox test files: two bank CSV layouts, a text lease PDF, a text mortgage statement PDF and a
scanned (image-only) lease PDF. Names and rents match the demo workspace's tenants (GET /api/rentroll).

    .venv/bin/python tests/fixtures/make_fixtures.py
"""
from __future__ import annotations

import io
from pathlib import Path

HERE = Path(__file__).resolve().parent


# ---------- bank exports ----------

CHASE = """Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
CREDIT,11/03/2026,ZELLE PAYMENT FROM CASEY PORTER 8812734,1450.00,QUICKPAY_CREDIT,18842.17,
CREDIT,11/03/2026,ZELLE PAYMENT FROM RILEY PORTER 8812790,1500.00,QUICKPAY_CREDIT,20342.17,
CREDIT,11/04/2026,ONLINE TRANSFER FROM R GRAHAM CHK 4471,2150.00,ACCT_XFER,22492.17,
CREDIT,11/05/2026,MOBILE DEPOSIT REF 30019,1050.00,CHECK_DEPOSIT,23542.17,
CREDIT,11/06/2026,ZELLE PAYMENT FROM DREW GRAHAM 8813302,1100.00,QUICKPAY_CREDIT,24642.17,
CREDIT,11/09/2026,VENMO CASHOUT JORDAN PARKER,575.00,ACH_CREDIT,25217.17,
DEBIT,11/01/2026,ROCKET MORTGAGE PMT 3301,-1162.21,ACH_DEBIT,17392.17,
DEBIT,11/07/2026,THE HOME DEPOT #3812 COLUMBUS OH,-186.42,DEBIT_CARD,25030.75,
DEBIT,11/07/2026,THE HOME DEPOT #3812 COLUMBUS OH,-186.42,DEBIT_CARD,24844.33,
DEBIT,11/10/2026,CITY OF COLUMBUS UTILITIES 3647 MEDINA,-281.40,ACH_DEBIT,24562.93,
DEBIT,11/12/2026,STATE FARM INSURANCE 0042 PREMIUM,-1732.50,ACH_DEBIT,22830.43,
DEBIT,11/13/2026,ROTO-ROOTER PLUMBING 4119 GREENWAY,-325.00,DEBIT_CARD,22505.43,
DEBIT,11/14/2026,CAPITAL CITY PM MGMT FEE OCT,-264.00,ACH_DEBIT,22241.43,
DEBIT,11/15/2026,STARBUCKS STORE 0921,-6.45,DEBIT_CARD,22234.98,
"""

# Bank of America style: a summary block above the header, separate withdrawal / deposit columns, quoted amounts.
BOA = """Description,,Summary Amt.
Beginning balance as of 10/01/2026,,"14,021.88"
Total credits,,"8,400.00"
Total debits,,"-3,982.46"
Ending balance as of 10/31/2026,,"18,439.42"

Date,Description,Withdrawals,Deposits,Running Bal.
10/01/2026,"Online Banking transfer from CHK 2291 Confirmation# 4KQ Casey Porter",,"1,450.00","15,471.88"
10/02/2026,"Zelle Transfer Conf# J1RR Riley Porter; Oct rent",,"1,500.00","16,971.88"
10/03/2026,"REESE GRAHAM DES:RENT ID:XXXX INDN:LANDLORD CO ID:XXXXX PPD",,"2,150.00","19,121.88"
10/05/2026,"FRANKLIN COUNTY TREASURER DES:PROP TAX",-2520.00,,"16,601.88"
10/06/2026,"COLUMBIA GAS OF OHIO DES:BILL PAY",-88.17,,"16,513.71"
10/08/2026,"LOWES #01883 COLUMBUS OH",-412.90,,"16,100.81"
10/11/2026,"GREEN LAWN LANDSCAPING LLC",-145.00,,"15,955.81"
10/14/2026,"SAM PORTER DES:MOBILE DEP",,"1,050.00","17,005.81"
10/20/2026,"MR. COOPER DES:MORTGAGE ID:5531",-1214.39,,"15,791.42"
10/22/2026,"Zelle Transfer Conf# 9QZT Drew Graham",,"1,100.00","16,891.42"
10/25/2026,"APARTMENTS.COM LISTING FEE",-29.00,,"16,862.42"
10/28/2026,"Zelle Transfer Conf# 0PLC Jordan Parker",,"1,150.00","18,012.42"
10/30/2026,"RUMPKE WASTE 3647 MEDINA",-73.00,,"17,939.42"
"""


# ---------- a minimal text PDF written by hand (Helvetica, one or more pages) ----------

def _esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def text_pdf(pages: list[list[tuple[str, float]]]) -> bytes:
    """pages: [[(text, font size), ...], ...] — each tuple is one line, top to bottom."""
    objs: list[bytes] = []
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(b"")                                    # pages tree, filled in below
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    kids = []
    for lines in pages:
        y, ops = 740.0, ["BT"]
        for text, size in lines:
            font = "/F2" if size >= 12 else "/F1"
            if text:
                ops.append(f"{font} {size:g} Tf 1 0 0 1 64 {y:.1f} Tm ({_esc(text)}) Tj")
            y -= size * 1.55 if text else 9
        ops.append("ET")
        stream = "\n".join(ops).encode("cp1252")
        objs.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        content = len(objs)
        objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents %d 0 R >>" % content)
        kids.append(len(objs))
    objs[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % k for k in kids), len(kids))
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offs = []
    for i, o in enumerate(objs, start=1):
        offs.append(out.tell())
        out.write(b"%d 0 obj\n" % i + o + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for off in offs:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref))
    return out.getvalue()


LEASE = [[
    ("RESIDENTIAL LEASE AGREEMENT", 15),
    ("", 0),
    ("This Residential Lease Agreement is made on October 20, 2026 between Maple Row Holdings LLC", 9.5),
    ('("Landlord") and Morgan Ellis ("Tenant") for the premises described below.', 9.5),
    ("", 0),
    ("1. PARTIES AND PREMISES", 12),
    ("Landlord: Maple Row Holdings LLC", 9.5),
    ("Tenant: Morgan Ellis", 9.5),
    ("Premises: 3647 Medina St, Unit D, Columbus, OH 43211", 9.5),
    ("", 0),
    ("2. TERM", 12),
    ("The lease commences on December 1, 2026 and ends on November 30, 2027.", 9.5),
    ("", 0),
    ("3. RENT", 12),
    ("Monthly Rent: $1,175.00 per month", 9.5),
    ("Rent is due on or before the 1st day of each month, payable by electronic transfer.", 9.5),
    ("Late Fee: $75.00 if rent is not received within 5 days after the due date.", 9.5),
    ("", 0),
    ("4. SECURITY DEPOSIT", 12),
    ("Security Deposit: $1,175.00, held in a separate account and returned within 30 days of move-out.", 9.5),
    ("", 0),
    ("5. UTILITIES AND MAINTENANCE", 12),
    ("Tenant pays electric and gas. Landlord pays water, sewer and trash.", 9.5),
    ("Tenant shall keep the premises clean and report needed repairs promptly in writing.", 9.5),
], [
    ("6. SIGNATURES", 12),
    ("Landlord: ______________________   Date: __________", 9.5),
    ("Tenant: ________________________   Date: __________", 9.5),
]]

MORTGAGE = [[
    ("Buckeye Federal Bank", 15),
    ("Mortgage Statement", 12),
    ("", 0),
    ("Statement Date: 11/01/2026", 9.5),
    ("Loan Number: 0048213377", 9.5),
    ("Property Address: 3378 Lakeview Pl, Columbus, OH 43214", 9.5),
    ("", 0),
    ("Payment Due Date: 12/01/2026", 9.5),
    ("Amount Due: $1,860.62", 9.5),
    ("If payment is received after 12/16/2026, a $72.05 late fee will be charged.", 9.5),
    ("", 0),
    ("Explanation of Amount Due", 12),
    ("Principal: $285.47", 9.5),
    ("Interest: $1,155.59", 9.5),
    ("Principal & Interest: $1,441.07", 9.5),
    ("Escrow Payment: $419.55", 9.5),
    ("", 0),
    ("Account Information", 12),
    ("Interest Rate: 6.125%", 9.5),
    ("Unpaid Principal Balance: $226,402.17", 9.5),
    ("Escrow Balance: $1,258.30", 9.5),
    ("Maturity Date: 06/01/2053", 9.5),
]]


def scanned_pdf() -> bytes:
    """An image-only page, the way a phone scan arrives: no text layer at all."""
    from PIL import Image, ImageDraw
    im = Image.new("L", (850, 1100), 247)
    d = ImageDraw.Draw(im)
    d.rectangle([90, 90, 760, 130], fill=60)
    for i in range(34):
        y = 180 + i * 26
        d.rectangle([90, y, 90 + (620 if i % 6 else 300), y + 9], fill=150)
    buf = io.BytesIO()
    im.save(buf, "PDF", resolution=100)
    return buf.getvalue()


def main():
    (HERE / "bank_chase_nov2026.csv").write_text(CHASE)
    (HERE / "bank_boa_oct2026.csv").write_text(BOA)
    (HERE / "lease_3647_medina_unit_d.pdf").write_bytes(text_pdf(LEASE))
    (HERE / "mortgage_statement_lakeview_nov2026.pdf").write_bytes(text_pdf(MORTGAGE))
    (HERE / "lease_scanned_greenway.pdf").write_bytes(scanned_pdf())
    for p in sorted(HERE.glob("*.*")):
        if p.suffix in (".csv", ".pdf"):
            print(f"{p.name:44s} {p.stat().st_size:>7,d} bytes")


if __name__ == "__main__":
    main()

"""Integer-paise arithmetic shared by the generator.

Must stay identical to packages/engine/src/money.ts: every amount is an integer
number of paise and every rounding is half-up on non-negative integers.
"""


def div_half_up(numerator: int, denominator: int) -> int:
    if numerator < 0:
        return -div_half_up(-numerator, denominator)
    return (numerator * 2 + denominator) // (denominator * 2)


def line_taxable(qty: int, rate_paise: int, discount_pct: int) -> int:
    return div_half_up(qty * rate_paise * (100 - discount_pct), 100)


def pct_of(amount_paise: int, pct_x100: int) -> int:
    """pct_x100 is the rate in hundredths of a percent (9% -> 900)."""
    return div_half_up(amount_paise * pct_x100, 10000)


def bp_of(amount_paise: int, basis_points: int) -> int:
    return div_half_up(amount_paise * basis_points, 10000)


def round_to_rupee(paise: int) -> int:
    return div_half_up(paise, 100) * 100


def inr(paise: int, symbol: bool = False) -> str:
    """Indian digit grouping: 1,84,000.00"""
    negative = paise < 0
    paise = abs(paise)
    rupees, p = divmod(paise, 100)
    s = str(rupees)
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        s = ",".join(groups) + "," + tail
    out = f"{s}.{p:02d}"
    if symbol:
        out = "Rs. " + out
    return ("-" if negative else "") + out


_ONES = (
    "Zero One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve Thirteen "
    "Fourteen Fifteen Sixteen Seventeen Eighteen Nineteen"
).split()
_TENS = "_ _ Twenty Thirty Forty Fifty Sixty Seventy Eighty Ninety".split()


def _two(n: int) -> str:
    if n < 20:
        return _ONES[n]
    t, o = divmod(n, 10)
    return _TENS[t] + ("" if o == 0 else " " + _ONES[o])


def _three(n: int) -> str:
    h, r = divmod(n, 100)
    parts = []
    if h:
        parts.append(_ONES[h] + " Hundred")
    if r:
        parts.append(_two(r))
    return " ".join(parts)


def words(paise: int) -> str:
    """Rupees in Indian numbering words, as printed on invoices."""
    rupees = paise // 100
    if rupees == 0:
        return "Rupees Zero Only"
    crore, rest = divmod(rupees, 10_000_000)
    lakh, rest = divmod(rest, 100_000)
    thousand, rest = divmod(rest, 1000)
    parts = []
    if crore:
        parts.append(_three(crore) + " Crore")
    if lakh:
        parts.append(_two(lakh) + " Lakh")
    if thousand:
        parts.append(_two(thousand) + " Thousand")
    if rest:
        parts.append(_three(rest))
    p = paise % 100
    tail = f" and {_two(p)} Paise" if p else ""
    return "Rupees " + " ".join(parts) + tail + " Only"


_GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin_checksum(first14: str) -> str:
    total = 0
    for i, ch in enumerate(first14):
        value = _GSTIN_CHARS.index(ch)
        product = value * (2 if i % 2 else 1)
        total += product // 36 + product % 36
    return _GSTIN_CHARS[(36 - total % 36) % 36]


def make_gstin(state: str, pan: str, entity: str = "1") -> str:
    base = f"{state}{pan}{entity}Z"
    return base + gstin_checksum(base)

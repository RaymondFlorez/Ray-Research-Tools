"""Static SIC code -> sector (division) / industry (major group) classification.

The SEC reports each filer's 4-digit SIC code but no sector/industry text
beyond `sicDescription`. SIC itself is a public-domain U.S. government
classification (OSHA/Census) with a fixed hierarchy:

    first 2 digits -> "major group" (our `industry`)
    major group    -> "division"    (our `sector`)

This module ships the full division table and major-group table inline (both
are small, stable since 1987, and public domain), so sector/industry can be
derived offline from the SIC code the SEC already gives us -- no extra
network source needed.
"""
from __future__ import annotations

# Division ranges keyed by (low_major_group, high_major_group), inclusive.
_DIVISIONS: list[tuple[int, int, str]] = [
    (1, 9, "Agriculture, Forestry, and Fishing"),
    (10, 14, "Mining"),
    (15, 17, "Construction"),
    (20, 39, "Manufacturing"),
    (40, 49, "Transportation, Communications, Electric, Gas, and Sanitary Services"),
    (50, 51, "Wholesale Trade"),
    (52, 59, "Retail Trade"),
    (60, 67, "Finance, Insurance, and Real Estate"),
    (70, 89, "Services"),
    (91, 99, "Public Administration"),
]

_MAJOR_GROUPS: dict[int, str] = {
    1: "Agricultural Production - Crops",
    2: "Agricultural Production - Livestock",
    7: "Agricultural Services",
    8: "Forestry",
    9: "Fishing, Hunting and Trapping",
    10: "Metal Mining",
    12: "Coal Mining",
    13: "Oil and Gas Extraction",
    14: "Mining and Quarrying of Nonmetallic Minerals",
    15: "Building Construction - General Contractors",
    16: "Heavy Construction",
    17: "Construction - Special Trade Contractors",
    20: "Food and Kindred Products",
    21: "Tobacco Products",
    22: "Textile Mill Products",
    23: "Apparel and Other Finished Products",
    24: "Lumber and Wood Products",
    25: "Furniture and Fixtures",
    26: "Paper and Allied Products",
    27: "Printing, Publishing and Allied Industries",
    28: "Chemicals and Allied Products",
    29: "Petroleum Refining and Related Industries",
    30: "Rubber and Miscellaneous Plastics Products",
    31: "Leather and Leather Products",
    32: "Stone, Clay, Glass, and Concrete Products",
    33: "Primary Metal Industries",
    34: "Fabricated Metal Products",
    35: "Industrial and Commercial Machinery and Computer Equipment",
    36: "Electronic and Other Electrical Equipment",
    37: "Transportation Equipment",
    38: "Measuring, Analyzing and Controlling Instruments",
    39: "Miscellaneous Manufacturing Industries",
    40: "Railroad Transportation",
    41: "Local and Suburban Transit",
    42: "Motor Freight Transportation and Warehousing",
    44: "Water Transportation",
    45: "Transportation by Air",
    46: "Pipelines, Except Natural Gas",
    47: "Transportation Services",
    48: "Communications",
    49: "Electric, Gas, and Sanitary Services",
    50: "Wholesale Trade - Durable Goods",
    51: "Wholesale Trade - Nondurable Goods",
    52: "Building Materials, Hardware, Garden Supply",
    53: "General Merchandise Stores",
    54: "Food Stores",
    55: "Automotive Dealers and Gasoline Service Stations",
    56: "Apparel and Accessory Stores",
    57: "Home Furniture, Furnishings, and Equipment Stores",
    58: "Eating and Drinking Places",
    59: "Miscellaneous Retail",
    60: "Depository Institutions",
    61: "Non-depository Credit Institutions",
    62: "Security and Commodity Brokers, Dealers, Exchanges",
    63: "Insurance Carriers",
    64: "Insurance Agents, Brokers and Service",
    65: "Real Estate",
    67: "Holding and Other Investment Offices",
    70: "Hotels, Rooming Houses, Camps, and Other Lodging",
    72: "Personal Services",
    73: "Business Services",
    75: "Automotive Repair, Services and Parking",
    76: "Miscellaneous Repair Services",
    78: "Motion Pictures",
    79: "Amusement and Recreation Services",
    80: "Health Services",
    81: "Legal Services",
    82: "Educational Services",
    83: "Social Services",
    84: "Museums, Art Galleries, and Botanical Gardens",
    86: "Membership Organizations",
    87: "Engineering, Accounting, Research, Management Services",
    88: "Private Households",
    89: "Services, Not Elsewhere Classified",
    91: "Executive, Legislative, and General Government",
    92: "Justice, Public Order, and Safety",
    93: "Public Finance, Taxation, and Monetary Policy",
    94: "Administration of Human Resource Programs",
    95: "Administration of Environmental Quality and Housing",
    96: "Administration of Economic Programs",
    97: "National Security and International Affairs",
    99: "Nonclassifiable Establishments",
}


def sic_to_sector(sic_code: str | int | None) -> str | None:
    """Map a 4-digit SIC code to its division name, e.g. 3571 -> 'Manufacturing'."""
    major_group = _major_group(sic_code)
    if major_group is None:
        return None
    for low, high, name in _DIVISIONS:
        if low <= major_group <= high:
            return name
    return None


def sic_to_industry(sic_code: str | int | None) -> str | None:
    """Map a 4-digit SIC code to its major-group name, e.g. 3571 -> 'Industrial and
    Commercial Machinery and Computer Equipment'."""
    major_group = _major_group(sic_code)
    if major_group is None:
        return None
    return _MAJOR_GROUPS.get(major_group)


def _major_group(sic_code: str | int | None) -> int | None:
    if sic_code is None:
        return None
    digits = str(sic_code).strip()
    if not digits.isdigit() or len(digits) > 4:
        return None
    return int(digits.zfill(4)[:2])

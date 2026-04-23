when showing prices, take saleprice into account. i dont want the marketing but i want to see the actual price and since we also have saleuntil, we could show this to order in time
sale price
{
    "productId": 15083,
    "image": {
        "path": "https://cdn.knuspr.de/images/grocery/products/15083/15083-1736410391239.jpg",
        "backgroundColor": "#F6F6F6"
    },
    "name": "BIO Blumenkohl, 1 Stk.",
    "slug": "bio-blumenkohl-1-stk",
    "brand": null,
    "countryOfOriginFlagIconPath": null,
    "favorites": {
        "canBeFavorite": true,
        "favorite": true
    },
    "unit": "Stk",
    "textualAmount": "1 Stk",
    "weightedItem": false,
    "badges": [
        {
            "position": "PRICE",
            "type": null,
            "text": "-25 % bis 26. 4.",
            "textColor": "#1C2529",
            "backgroundColor": "#FFF6C8",
            "link": null,
            "icon": null,
            "trailingIcon": null
        },
        {
            "position": "PRODUCT",
            "type": "TAG_BASED_BADGE",
            "text": "BIO",
            "textColor": "#185729",
            "backgroundColor": "#DDF4DE",
            "link": null,
            "icon": null,
            "trailingIcon": null
        }
    ],
    "prices": {
        "originalPrice": 4.99,
        "salePrice": 3.74,
        "unitPrice": 3.74,
        "saleId": 20127054,
        "salePriceStyle": {
            "textColor": "#1C2529",
            "backgroundColor": "#FFE55A"
        },
        "saleValidTill": "2026-04-26T23:59:00+02:00",
        "saleText": "-25 %",
        "currency": "EUR"
    },
    "stock": {
        "maxAvailableAmount": 50,
        "availabilityStatus": "AVAILABLE",
        "availabilityReason": null
    },
    "tooltips": [
        {
            "type": "PRODUCT_EXTREME_WEIGHT",
            "closable": true,
            "triggerAmount": 2,
            "size": null,
            "message": "Du bestellst eine große Menge, bitte bestätige, dass diese korrekt ist.",
            "actionable": false
        }
    ],
    "ratings": [
        {
            "type": "favourites",
            "rating": 17428,
            "externalId": null,
            "count": null,
            "countToShow": null
        }
    ],
    "type": "PRODUCT"
}


out of stock items should be marked
{
    "productId": 12313,
    "image": {
        "path": "https://cdn.knuspr.de/images/grocery/products/12313/12313-1630774682461.jpeg",
        "backgroundColor": "#F6F6F6"
    },
    "name": "Zitronen, Netz",
    "slug": "zitronen-netz",
    "brand": null,
    "countryOfOriginFlagIconPath": null,
    "favorites": {
        "canBeFavorite": true,
        "favorite": true
    },
    "unit": "kg",
    "textualAmount": "500 g",
    "weightedItem": false,
    "badges": [
        {
            "position": "CTA_BUTTON",
            "type": "FIND_SIMILAR",
            "text": "Ähnliches finden",
            "textColor": "#FFFFFF",
            "backgroundColor": "#2F7D3B",
            "link": "/c18",
            "icon": null,
            "trailingIcon": null
        },
        {
            "position": "PRODUCT",
            "type": "TAG_BASED_BADGE",
            "text": "Knuspr-Günstig",
            "textColor": "#FFFFFF",
            "backgroundColor": "#E16E64",
            "link": null,
            "icon": null,
            "trailingIcon": null
        }
    ],
    "prices": {
        "originalPrice": 1.59,
        "salePrice": null,
        "unitPrice": 3.18,
        "saleId": null,
        "salePriceStyle": null,
        "saleValidTill": null,
        "saleText": null,
        "currency": "EUR"
    },
    "stock": {
        "maxAvailableAmount": 0,
        "availabilityStatus": "UNAVAILABLE",
        "availabilityReason": "Wsl. wieder verfügbar am Mi."
    },
    "tooltips": [
        {
            "type": "PRODUCT_EXTREME_WEIGHT",
            "closable": true,
            "triggerAmount": 6,
            "size": null,
            "message": "Du bestellst eine große Menge, bitte bestätige, dass diese korrekt ist.",
            "actionable": false
        }
    ],
    "ratings": [
        {
            "type": "favourites",
            "rating": 39112,
            "externalId": null,
            "count": null,
            "countToShow": null
        }
    ],
    "type": "PRODUCT"
}

i like to see similar products when requested
https://www.knuspr.de/api/v1/products/9109/similar
{
    "productId": 9109,
    "similarProducts": [
        80353,
        11991,
        32159,
        80214,
        223784,
        3855,
        32158,
        119795,
        100134,
        119794
    ]
}

sync connected account on login when older than 1h


add suggestion page that when i ordered an item often so put on favorite
https://www.knuspr.de/api/v1/categories/favorite/products?page=0&size=15&sort=recommended&excludeProductIds=
{
    "categoryId": null,
    "categoryType": "favorite",
    "productIds": [
        7010,
        30047,
        20990,
        118152,
        93006,
        9109,
        14240,
        19540,
        20123,
        72167,
        7498,
        14381,
        958,
        13724,
        3373
    ],
    "productsWithType": [
        {
            "id": 7010,
            "type": "PRODUCT"
        },
        {
            "id": 30047,
            "type": "PRODUCT"
        },
        {
            "id": 20990,
            "type": "PRODUCT"
        },
        {
            "id": 118152,
            "type": "PRODUCT"
        },
        {
            "id": 93006,
            "type": "PRODUCT"
        },
        {
            "id": 9109,
            "type": "PRODUCT"
        },
        {
            "id": 14240,
            "type": "PRODUCT"
        },
        {
            "id": 19540,
            "type": "PRODUCT"
        },
        {
            "id": 20123,
            "type": "PRODUCT"
        },
        {
            "id": 72167,
            "type": "PRODUCT"
        },
        {
            "id": 7498,
            "type": "PRODUCT"
        },
        {
            "id": 14381,
            "type": "PRODUCT"
        },
        {
            "id": 958,
            "type": "PRODUCT"
        },
        {
            "id": 13724,
            "type": "PRODUCT"
        },
        {
            "id": 3373,
            "type": "PRODUCT"
        }
    ],
    "impressions": [],
    "interactiveProductCardAds": [],
    "pageable": {
        "pageNumber": 0,
        "pageSize": 15,
        "sort": {
            "empty": true,
            "sorted": false,
            "unsorted": true
        },
        "offset": 0,
        "paged": true,
        "unpaged": false
    }
}
const { MongoClient } = require('mongodb')

function getRequest (url) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? require('https') : require('http')
        const request = lib.get(url, response => {
            if (response.statusCode < 200 || response.statusCode > 299) {
                reject(new Error('Failed to load, status code: ' + response.statusCode))
             }
            const body = []
            response.on('data', chunk => body.push(chunk))
            response.on('end', () => resolve(body.join('')))
          })
        request.on('error', err => reject(err))
    })
}

function getApiOrders (url, limit, date, after ) {
    return new Promise((resolve, reject) => {
        let addToUrl = ''
        if (limit) addToUrl = addToUrl + '&limit=' + limit
        let direction
        after ? direction =  '&after=' : direction =  '&before='
        if (date) addToUrl = addToUrl + direction + Math.round(new Date(date).getTime()/1000)
        getRequest (url + addToUrl)
        .then(data => {
            const dataObj = JSON.parse(data)
            if (dataObj.success) {
                resolve (dataObj.params.orderList)
            } else {
                reject(new Error('Failed to load'))
            }
          })
        .catch (err => reject(err) )
    })
}

async function getOrdersData(config) {
    let ordersList= []
    let productList= []
    const mongoClient = new MongoClient(config.mongoUri, { useUnifiedTopology: true })
    try {
        await mongoClient.connect()
        const ordersCollection = mongoClient.db('pmg').collection('orders')
        //add fresh orders
        const lastApiOrder = await getApiOrders(config.eshopUri,1)
        const lastApiOrderId = lastApiOrder[0].id_order
        const lastDbOrder = await ordersCollection.findOne({}, {sort: {id_order: -1}})
        const lastDbOrderId = lastDbOrder.id_order
        if (lastApiOrderId > lastDbOrderId) {
            const newOrdersCount = lastApiOrderId - lastDbOrderId
            if (newOrdersCount < 100) {
                const freshApiOrders = await getApiOrders(config.eshopUri, newOrdersCount)
                const result = await ordersCollection.insertMany(freshApiOrders)
                console.log(`${result.insertedCount} fresh orders inserted`)
            }
        }
        //read and process new, paid and unpaid orders
        const dbQuery = { vyrizeno : { $in: ['c','d','n'] } }
        const dbOptions = { sort: {'id_order': -1} }
        await ordersCollection.find(dbQuery, dbOptions).forEach(order => {
            let status = ''
            let toSend = false
            if (order.gateway_payment_state && order.gateway_payment_state != "paid") status='Ne'
            if (order.gateway_payment_state == "paid" || order.vyrizeno == "c") status='Ano'
            if (order.payment.nazev_platba == "Platba předem na účet" && order.vyrizeno != "c" ) status='Ne'
            if (order.payment.nazev_platba == "Platba dobírkou" || status=='Ano') toSend = true

            order.row_list.forEach(product => {
                productList.push({
                    orderId: order.id_order,
                    orderNumber: order.number,
                    productType: product.product_name,
                    productId: product.product_number,
                    size: product.variant_description.split(' ')[2],
                    price: product.price_total_with_vat,
                    count: product.count,
                    sale: toSend
                })
            })
            ordersList.push({
                id: order.id_order,
                number: order.number,
                name: order.customer.delivery_information.name,
                delivery: order.delivery.nazev_postovne.split(' - ')[0], 
                payment: order.payment.nazev_platba,
                status: status,
                date: order.origin.date.date.slice(5,16),
                toSend: toSend,
            })
        })
        //assign stores and action 'n' or 'u'
        const inventoryCollection = mongoClient.db('pmg').collection('variants')
        const salesCollection = mongoClient.db('pmg').collection('sales')
        for (i=0; i<productList.length; i++) {
            let product = productList[i]
            let storeID = "Neni"
            let storePrice = 0
            let action = 'n'
            let size = product.size
            if (typeof(size) == "number" ) {size = size.toString()}
            let stock = await inventoryCollection.findOne({
                model: product.productId,
                size: product.size,
            })
            if (stock !== null) {
                let i=0
                let founded=false 
                while (!founded && i < stock.inventory.length) {
                    if (stock.inventory[i].quantity > 0) {
                        founded=true
                        storeID=stock.inventory[i].id
                        storePrice=stock.inventory[i].price
                    }
                    i++
                }
            } else {storeID = "Nové"}
            let sold = await salesCollection.findOne({
                items: {$elemMatch: { 
                    orderId: product.orderNumber, 
                    productId: product.productId,
                    size: product.size,
                }}
            })
            if (sold !== null) { action = 'u' }
            productList[i].storeID = storeID
            productList[i].action = action
            productList[i].storePrice = storePrice
        }
    } catch(err) {
        console.log('Get orders data error:' + err.message)
    } finally { mongoClient.close() }
    return { 
        ordersList: ordersList,
        productList: productList,
    }
} 

async function saveSale(config, items, storeID) {
    const mongoClient = new MongoClient(config.mongoUri, { useUnifiedTopology: true })
    let date = new Date()
    let newSale = {date: date.toISOString().slice(0,10)}
    try {
        await mongoClient.connect()
        const salesCollection = mongoClient.db('pmg').collection('sales')
        let totalSum = 0
        let totalCount = 0
        let totalPriceDif = 0
        itemsList = []
        items.forEach(item => {
            itemsList.push({
                orderId: item.orderNumber,
                productId: item.productId,
                size: item.size,
                price: item.storePrice,
                count: item.count,
                total: item.count*item.storePrice,
            })
            totalSum = totalSum + item.count*item.storePrice
            totalCount = totalCount + item.count
            totalPriceDif  = totalPriceDif + item.price - item.storePrice
        })
        newSale.totalSum = totalSum
        newSale.totalCount = totalCount
        newSale.totalPriceDif = totalPriceDif
        newSale.storeID = storeID
        newSale.items = itemsList
        await salesCollection.insertOne(newSale)
    } catch(err) {
        console.log('Save sale data error:' + err.message)
    } finally { mongoClient.close() }
    return newSale
} 

async function getSales(config, storeID, date) {
    const mongoClient = new MongoClient(config.mongoUri, { useUnifiedTopology: true })
    let sales = []
    let daySalesTotal = 0
    try {
        await mongoClient.connect()
        const salesCollection = mongoClient.db('pmg').collection('sales')
        sales = await salesCollection.find({ date: date, storeID: storeID}).toArray()
        if (sales.length > 0) sales.forEach(sale => {daySalesTotal = daySalesTotal + sale.totalSum})
    } catch(err) {
        console.log('Get sales data error:' + err.message)
    } finally { mongoClient.close() }
    return {salesData : sales, daySales: daySalesTotal, date: date, id: storeID }
} 


async function getOrdersByItem (config, item) {
    const mongoClient = new MongoClient(config.mongoUri, { useUnifiedTopology: true })
    let orders = []
    try {
        await mongoClient.connect()
        const inventoryCollection = mongoClient.db('pmg').collection('variants')
        const ordersCollection = mongoClient.db('pmg').collection('orders')
        let itemID
        if (item.length == 13) {
            const ean = parseInt(item, 10)
            const variant = await inventoryCollection.findOne({ ean: ean })
            if (variant !== null) itemID=variant["_id"]
        } else {
            const params = item.split('-')
            console.log(params)
            const model = params[0].toString()
            const size = params[1].toString()
            console.log(model,size)
            const variant = await inventoryCollection.findOne({ model: model, size: size })
            console.log(variant)
            if (variant !== null) itemID=variant["_id"]
        }
        if (itemID !== undefined) {
            itemID = itemID.split('_')
            const productID= parseInt(itemID[0], 10)
            const variantID = parseInt(itemID[1], 10)
            const dbQuery = { 
                row_list: {$elemMatch: { 
                    variant_id: variantID, 
                    product_id: productID,
                }}}
            const dbOptions = {projection: {
                '_id': 0,
                'id_order': 1,
                'number': 1,
                'origin': 1,
                'customer': 1,
                'payment': 1,
                'delivery': 1,
                'vyrizeno': 1,
            },
            sort: [['id_order', 1]]
          }
            const selection = ordersCollection.find(dbQuery, dbOptions)
            await selection.forEach(order => {
                const statusVariants = {
                    "n": "Nová",
                    "a": "Vyřízená",
                    "b": "Odeslaná",
                    "c": "Zaplacená",
                    "d": "Přijatá",
                    "e": "Zrušená",
                    "f": "Dobropis",
                    "g": "Osobní odběr",
                  }
                  let status = statusVariants[order.vyrizeno] 
                  orders.unshift({
                    number: order.number,
                    name: order.customer.delivery_information.name,
                    delivery: order.delivery.nazev_postovne.split(' - ')[0], 
                    payment: order.payment.nazev_platba,
                    date: order.origin.date.date.slice(0,10),
                    status: status
                  })
            })
        }
    } catch(err) {
        console.log('Get orders data error:' + err.message)
    } finally { mongoClient.close() }
    return {orders : orders}
} 

module.exports = {
    getOrdersData : getOrdersData,
    saveSale : saveSale,
    getSales : getSales,
    getOrdersByItem : getOrdersByItem,
}
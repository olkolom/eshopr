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
        
        //add fresh and update new, paid and unpaid orders
        const ordersToUpdate = await ordersCollection.find(
            { vyrizeno : { $in: ['c','d','n'] } }, 
            { sort: {'id_order': -1}, projection: { '_id': 0, 'id_order': 1}})
            .toArray()
        const firstDbOrderId = ordersToUpdate[ordersToUpdate.length-1]['id_order']
        const lastDbOrder = await ordersCollection.findOne({}, {sort: {id_order: -1}, projection: { '_id': 0, 'id_order': 1}})
        const lastDbOrderId = lastDbOrder.id_order
        const lastApiOrder = await getApiOrders(config.eshopUri,1)
        const lastApiOrderId = lastApiOrder[0].id_order
        let ordersCount = lastApiOrderId - firstDbOrderId + 1
        if (ordersCount > 99) ordersCount = 99 //TODO implement page read from api
        let newOrdersCount = lastApiOrderId - lastDbOrderId
        if (newOrdersCount > 99) newOrdersCount = 99 //TODO implement page read from api
        let apiOrders = await getApiOrders(config.eshopUri, ordersCount)
        const freshApiOrders = apiOrders.slice(0, newOrdersCount)
        if (freshApiOrders.length > 0) {
            let result = await ordersCollection.insertMany(freshApiOrders)
            console.log(`${result.insertedCount} fresh orders inserted`)
        }
        let updatedOrders = 0
        for (let i=0; i<ordersToUpdate.length; i++) {
            let orderIdToUpdate = ordersToUpdate[i]['id_order']
            let orderIndex = apiOrders.findIndex(e => e['id_order'] === orderIdToUpdate)
            let result
            if (orderIndex !== -1) {
                result = await ordersCollection.replaceOne(
                    { 'id_order' : apiOrders[orderIndex]['id_order'] }, apiOrders[orderIndex])
                if (result.modifiedCount === 1) updatedOrders++
            }
        }
        console.log(`${updatedOrders} orders updated from ${ordersToUpdate.length}`)

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
        for (let i=0; i<productList.length; i++) {
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
        //add returns to productList
        const returnsCollection = mongoClient.db('pmg').collection('returns')
        const returns = returnsCollection.find({'items.saved': false})
        await returns.forEach(ret => {
            ret.items.forEach(item => {
                if (!item.saved) productList.push({
                    ...item,
                    action: 'n',
                    sale: true,
                    ret: true
                })
            })
        })

    } catch(err) {
        console.log('Get orders data error:' + err)
    } finally { mongoClient.close() }
    return { 
        ordersList: ordersList,
        productList: productList,
    }
} 

async function getOrder(config, orderID) {
    const mongoClient = new MongoClient(config.mongoUri, { useUnifiedTopology: true })
    try {
        await mongoClient.connect()
        const ordersCollection = mongoClient.db('pmg').collection('orders')
        const order = await ordersCollection.findOne({number: orderID})
        orderData = {
                id: order.id_order,
                number: order.number,
                name: order.customer.delivery_information.name,
                delivery: order.delivery.nazev_postovne.split(' - ')[0],
                deliveryPrice: order.delivery.postovne,
                payment: order.payment.nazev_platba,
                paymentPrice: order.payment.castka_platba,
                date: order.origin.date.date.slice(5,16),
        }
        let items = []
        order.row_list.forEach(product => {
            items.push({
                orderId: order.id_order,
                orderNumber: order.number,
                productType: product.product_name,
                productId: product.product_number,
                size: product.variant_description.split(' ')[2],
                price: product.price_total_with_vat,
                count: product.count,
            })
        })
        const inventoryCollection = mongoClient.db('pmg').collection('variants')
        const salesCollection = mongoClient.db('pmg').collection('sales')
        for (i=0; i<items.length; i++) {
            let product = items[i]
            let storeID = "Neni"
            let storePrice = 0
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
            if (sold !== null) { 
                storeID = sold.storeID
                soldItem = sold.items.find(e => (e.productId === product.productId && e.size === product.size ))
                storePrice = soldItem.price
            }
            items[i].storeID = storeID
            items[i].storePrice = storePrice
        }
        orderData.items = items
    } catch(err) {
        console.log('Get order data error:' + err.message)
    } finally { mongoClient.close() }
    return orderData
} 

async function saveReturn(config, data) {
    const mongoClient = new MongoClient(config.mongoUri, { useUnifiedTopology: true })
    if (data.delivery === undefined) { data.delivery = 0 }
    else { data.delivery = data.delivery * -1 }
    if (data.payment === undefined) { data.payment = 0 }
    else { data.payment = data.payment * -1 }
    let date = new Date()
    let newReturn = {
        ...data,
        date: date.toISOString().slice(0,10),
        totalSum: data.delivery + data.payment,
        totalCount: data.items.length * -1,
        datePay: ""
    }
    let sum =0, dif =0
    newReturn.items = data.items.map(item => {
        item.price = item.price * -1
        item.storePrice = item.storePrice * -1
        item.count = item.count * -1 
        item.saved = false
        sum = sum + item.price
        dif = dif +(item.price - item.storePrice)
        return item
    })
    newReturn.totalPriceDif = dif
    newReturn.totalSum = newReturn.totalSum + sum
    try {
        await mongoClient.connect()
        const returnsCollection = mongoClient.db('pmg').collection('returns')
        await returnsCollection.insertOne(newReturn)
    } catch(err) {
        console.log('Save return data error:' + err.message)
    } finally { mongoClient.close() }
    return newReturn
} 

async function getReturns(config, orderId) {
    let returns
    const mongoClient = new MongoClient(config.mongoUri, { useUnifiedTopology: true })
    try {
        await mongoClient.connect()
        const returnsCollection = mongoClient.db('pmg').collection('returns')
        returns = await returnsCollection.find().toArray()
    } catch(err) {
        console.log('Get returns data error:' + err.message)
    } finally { mongoClient.close() }
    return {returns: returns}
} 

async function saveSale(config, items, storeID) {
    const mongoClient = new MongoClient(config.mongoUri, { useUnifiedTopology: true })
    let date = new Date()
    let newSale = {date: date.toISOString().slice(0,10)}
    
    //action prepare
    if (storeID === 'Kotva') {
        const notInAction = ['45101031','45102031','45102501','45121001','45121041','45121042','45122001','45122051','45122591','45246502']
        let apparel = []
        items.forEach((item, index) => {
            if (item.productId.length> 7 && item.productId[1]< 7) 
                if (notInAction.find(i=> i==item.productID) === undefined ) apparel.push(index)
        })
        if (apparel.length > 2) apparel.forEach(index => items[index].storePrice = Math.round(items[index].storePrice * 0.8))
    }
    try {
        await mongoClient.connect()
        const salesCollection = mongoClient.db('pmg').collection('sales')
        let totalSum = 0
        let totalCount = 0
        let totalPriceDif = 0
        let itemsList = []
        let returnsIndexes = []
        items.forEach((item, index) => {
            if (item.count < 0) returnsIndexes.push(index)
            itemsList.push({
                orderId: item.orderNumber,
                productId: item.productId,
                size: item.size,
                price: item.storePrice,
                count: item.count,
                total: item.count*item.storePrice,
            })
            totalSum = totalSum + item.count*Math.abs(item.storePrice)
            totalCount = totalCount + item.count
            totalPriceDif  = totalPriceDif + item.price - item.storePrice
        })
        newSale.totalSum = totalSum
        newSale.totalCount = totalCount
        newSale.totalPriceDif = totalPriceDif
        newSale.storeID = storeID
        newSale.items = itemsList
        await salesCollection.insertOne(newSale)

        //update 'saved' status at returns
        const returnsCollection = mongoClient.db('pmg').collection('returns')
        for (let i=0; i<returnsIndexes.length; i++) {
            let item = items[returnsIndexes[i]]
            await returnsCollection.updateOne({order: item.orderNumber, items: {$elemMatch: { productId: item.productId, size: item.size }}},{ $set: { "items.$.saved" : true }})
        }

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
            const model = params[0].toString()
            const size = params[1].toString()
            const variant = await inventoryCollection.findOne({ model: model, size: size })
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

async function getItem (config, item) {
    const mongoClient = new MongoClient(config.mongoUri, { useUnifiedTopology: true })
    let searchedItem = null
    try {
        await mongoClient.connect()
        const inventoryCollection = mongoClient.db('pmg').collection('variants')
        if (item.length == 13) {
            const ean = parseInt(item, 10)
            searchedItem = await inventoryCollection.findOne({ ean: ean })
        } else {
            const params = item.split('-')
            const model = params[0].toString()
            const size = params[1].toString()
            searchedItem = await inventoryCollection.findOne({ model: model, size: size })
        }
    } catch(err) {
        console.log('Get item data error:' + err.message)
    } finally { mongoClient.close() }
    return searchedItem
} 

module.exports = {
    getOrdersData : getOrdersData,
    saveSale : saveSale,
    saveReturn : saveReturn,
    getReturns : getReturns,
    getSales : getSales,
    getOrdersByItem : getOrdersByItem,
    getOrder: getOrder,
    getItem: getItem,
}
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
        //assign stores and action 'n'
        const inventoryCollection = mongoClient.db('pmg').collection('variants')
        for (i=0; i<productList.length; i++) {
            let product = productList[i]
            let storeID = "Neni"
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
                    }
                    i++
                }
            } else {storeID = "Nové"}
            productList[i].storeID = storeID
            productList[i].action = 'n'
        }
    } catch(err) {
        console.log('Get orders data error:' + err.message)
    } 
    return { 
        ordersList: ordersList,
        productList: productList,
    }
} 

module.exports = getOrdersData
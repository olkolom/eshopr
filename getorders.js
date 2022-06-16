const { MongoClient } = require('mongodb')

//implementation of http get
function getRequest (url) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? require('https') : require('http')
        const request = lib.get(url, response => {
            if (response.statusCode < 200 || response.statusCode > 299) {
                reject(new Error('Failed to load, status code: ' + response.statusCode))
             }
            const body = []
            response.on('data', chunk => {
                body.push(chunk)
            })
            response.on('end', () => resolve(body.join('')))
          })
        request.on('error', err => reject(err))
    })
}

//configurable orders read with ER api
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
                console.log(`Loaded from API ${dataObj.params.orderList.length} orders`)
                resolve (dataObj.params.orderList)
            } else {
                reject(new Error('Failed to load from API'))
            }
          })
        .catch (err => reject(err) )
    })
}

async function getOrdersData(eshopUri) {
    let ordersList= []
    let productList= []
    let productIndex= 0
    try {
	//add fresh and update new, paid and unpaid orders
        console.log('Getting orders from DB')
        const ordersToUpdate = await ordersCollection.find(
            { vyrizeno : { $in: ['c','d','n','g'] } }, 
            { sort: {'id_order': -1}, projection: { '_id': 0, 'id_order': 1}})
            .toArray()
        console.log('done')
        const firstDbOrderId = ordersToUpdate[ordersToUpdate.length-1]['id_order']
        const lastDbOrder = await ordersCollection.findOne({}, {sort: {id_order: -1}, projection: { '_id': 0, 'id_order': 1}})
        const lastDbOrderId = lastDbOrder.id_order
        const lastApiOrder = await getApiOrders(eshopUri,1)
        const lastApiOrderId = lastApiOrder[0].id_order
        let ordersCount = lastApiOrderId - firstDbOrderId + 1
        if (ordersCount > 99) ordersCount = 99 //TODO implement page read from api
        let newOrdersCount = lastApiOrderId - lastDbOrderId
        if (newOrdersCount > 99) newOrdersCount = 99 //TODO implement page read from api
        console.log('Getting orders from API')
        let apiOrders = await getApiOrders(eshopUri, ordersCount)
        console.log('done')
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
        const dbQuery = { vyrizeno : { $in: ['c','d','n','g'] } }
        const dbOptions = { sort: {'id_order': 1} }
        const ordersSelection = await ordersCollection.find(dbQuery, dbOptions).toArray()
        for (orderIndex = 0; orderIndex < ordersSelection.length; orderIndex++) {
            const order = ordersSelection[orderIndex]
            let status = ''
            let toSend = false
            if (order.gateway_payment_state && order.gateway_payment_state != "paid") status='Ne'
            if (order.payment.nazev_platba == "Platba předem na účet" 
                && (order.vyrizeno != "c" || order.vyrizeno != "g")) status='Ne'
            if (order.gateway_payment_state == "paid" || order.vyrizeno == "c") status='Ano'
            if (order.delivery.nazev_postovne == "Osobní odběr" 
                && order.payment.nazev_platba == "Platba předem na účet" 
                && order.vyrizeno == "g") status='Ano'
            if (order.payment.nazev_platba == "Platba dobírkou" || status=='Ano') toSend = true
            let phone = order.customer.delivery_information.phone
            let psc = order.customer.delivery_information.zip
            
            //finding SK orders
            let skOrder = ''
            if ( ['0','8','9'].includes(psc[0]) ) skOrder = '?'
            if (phone.slice(phone.length - 9, phone.length - 8) == "9") skOrder = '?'
            const deliveryService= order.delivery.nazev_postovne.split(' - ')[0]
            if (['PPL Slovensko', 'Zásilkovna Slovensko', 'DPD Slovensko'].includes(deliveryService)) skOrder = '!'
            if (order.total_per_vat['20'] !== undefined) skOrder = '+'

            //Collect PPL data
            let adress = order.customer.delivery_information.street
            adress.trim()
            let adrArr = adress.split(' ')
            let dom = adrArr.pop()
            adress = adrArr.join(' ')
            if (phone.length !== 9) {
                phone = phone.slice(phone.length - 9, phone.length)}
            let dobirka = ''
            if (order.payment.nazev_platba == "Platba dobírkou") {
                if (order.total_per_vat['21'] == undefined) {
                    dobirka = order.total_per_vat['20'].price_with_vat
                } else {
                    dobirka = order.total_per_vat['21'].price_with_vat
                }
            }
            let pplData = {
                'vs': order.number,
                'poznamka': order.customer.delivery_information.note,
                'osoba': order.customer.delivery_information.name,
                'telefon': phone,
                'email': order.customer.delivery_information.email,
                'ulice': adress,
                'dom': dom,
                'mesto': order.customer.delivery_information.city,
                'psc': psc,
                'dobirka': dobirka,
            }
            
            //productlist + assign stores and action 'n' or 'u'
            for (i=order.row_list.length -1; i >= 0; i--) {
                const product = order.row_list[i]
                let productId = product.product_number
                let sizeParts = product.variant_description.split(' ')
                let size = sizeParts[2]
                if (sizeParts[3] !== undefined) { size = size + ' ' + sizeParts[3]}
                if (typeof(size) == "number" ) {size = size.toString()}
                //if quantity is >1 push item 'quantity' times
                let orderQuantity = product.count
                while (orderQuantity>0) {

                    //temporary solution to check more then one same item in orders, itemQuantity is for unsold items
                    let itemQuantity = 1
                    let sameOrderQuantity = 1
                    let backwCounter = productList.length - 1
                    while (backwCounter >= 0 ) {
                        let prevItem = productList[backwCounter]
                        if (productId === prevItem.productId && size === prevItem.size) {
                            if (prevItem.action !== 'u') itemQuantity++
                            if (prevItem.orderNumber === order.number) sameOrderQuantity++
                        }
                        backwCounter--
                    }
                    //also some code  at if code below
                    let storeID = "Neni"
                    let storePrice = 0
                    let action = 'n'
                    let saleDate = ""
                    //check if sold
                    let soldItems = []
                    await salesCollection.find({
                        items: {$elemMatch: { 
                            orderId: order.number, 
                            productId,
                            size,
                        }}
                    }).forEach( sale => {
                        sale.items.forEach( item => {
                            if (item.productId === productId && item.size === size) soldItems.push({storeID: sale.storeID, date: sale.date, price: item.price})    
                        })
                    })
                    if (soldItems.length >= sameOrderQuantity) { 
                        action = 'u'
                        storeID = soldItems[sameOrderQuantity-1].storeID
                        saleDate = soldItems[sameOrderQuantity-1].date.slice(-5)
                        storePrice = soldItems[sameOrderQuantity-1].price
                    } else {
                        //find candidate to sale
                        let stock = await inventoryCollection.findOne({ model: productId, size })
                        if (stock !== null) {
                            let i=0
                            let founded=false 
                            while (!founded && i < stock.inventory.length) {
                                if (stock.inventory[i].quantity > 0) {
                                    if (stock.inventory[i].quantity - itemQuantity >= 0) {
                                        founded=true
                                        storeID=stock.inventory[i].id
                                        storePrice=stock.inventory[i].price
                                    } else { itemQuantity = itemQuantity - stock.inventory[i].quantity}
                                }
                                i++
                            }
                        } else {storeID = "Nové"}
                    }
                    
                    productList.unshift({
                        orderId: order.id_order,
                        orderNumber: order.number,
                        productType: product.product_name,
                        productId,
                        size,
                        price: product.price_per_unit_with_vat,
                        count: 1, //always 1 instead of product.count,
                        sale: toSend,
                        delivery: order.delivery.nazev_postovne.split(' - ')[0],
                        date: saleDate,
                        storeID,
                        action,
                        storePrice,
                        index: productIndex,
                    })
                    productIndex++
                    orderQuantity--
                }
            }

            //ordersList
            ordersList.unshift({
                id: order.id_order,
                number: order.number,
                name: order.customer.delivery_information.name,
                delivery: order.delivery.nazev_postovne.split(' - ')[0], 
                payment: order.payment.nazev_platba,
                status,
                date: order.origin.date.date.slice(5,16),
                toSend,
                sender: '',
                pplData,
                multiStore: false,
                skOrder,
                allItemSold: true,
            })
        }
        
        //define sender and order status
        productList.forEach(item => {
            const orderIndex = ordersList.findIndex(order => order.number == item.orderNumber)
            let sender = item.storeID
            if (!ordersList[orderIndex].multiStore && ordersList[orderIndex].sender != '') {
                if (sender === 'Kotva' && ordersList[orderIndex].sender !== sender
                    || ordersList[orderIndex].sender == 'Kotva' && ordersList[orderIndex].sender !== sender) { ordersList[orderIndex].multiStore = true }
            }
            if (sender === 'Outlet') sender = 'Harfa'
            if (item.delivery === "Osobní odběr") {
                if (sender != 'Kotva') { ordersList[orderIndex].multiStore = true }
                sender = 'Kotva'
            }
            if (ordersList[orderIndex].sender === ''
                || (ordersList[orderIndex].sender === 'Kotva' && sender === 'Harfa')) 
                { ordersList[orderIndex].sender = sender }
            if (ordersList[orderIndex].allItemSold && item.date == '') ordersList[orderIndex].allItemSold = false
        })

        //add returns to productList
        const returns = returnsCollection.find({'items.saved': false})
        await returns.forEach(ret => {
            ret.items.forEach(item => {
                if (!item.saved) {
                    productList.push({
                        ...item,
                        action: 'n',
                        sale: true,
                        ret: true,
                        index: productIndex,
                    })
                    productIndex++
                }
            })
        })

    } catch(err) {
        console.log('Get orders data error:' + err)
    }
    return { ordersList, productList, }
} 

async function getOrder(orderID) {
    try {
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
        for (i=0; i<items.length; i++) {
            let product = items[i]
            let storeID = "Neni"
            let storePrice = 0
            let size = product.size
            let soldDate = ""
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
                soldDate = sold.date
            }
            items[i].storeID = storeID
            items[i].storePrice = storePrice
            items[i].date = soldDate
        }
        orderData.items = items
    } catch(err) {
        console.log('Get order data error:' + err.message)
    }
    return orderData
} 

async function saveReturn(data) {
    if (data.delivery === undefined) { data.delivery = 0 }
    else { data.delivery = data.delivery * -1 }
    if (data.payment === undefined) { data.payment = 0 }
    else { data.payment = data.payment * -1 }
    let date = new Date()
    let newReturn = {
        ...data,
        date: date.toISOString().slice(0,10),
        totalSum: data.delivery + data.payment,
        totalCount: 0,
        datePay: "",
        items: []
    }
    let sum =0, dif =0
    data.items.forEach(item => {
        let itemCount= item.count
        item.price = Math.round(item.price * -1 / item.count)
        item.storePrice = item.storePrice * -1
        item.count = -1 
        item.saved = false
        while (itemCount > 0) {
            sum = sum + item.price
            dif = dif +(item.price - item.storePrice)    
            newReturn.items.push(item)
            itemCount--
            newReturn.totalCount--
        }
    })
    newReturn.totalPriceDif = dif
    newReturn.totalSum = newReturn.totalSum + sum
    try {
        await returnsCollection.insertOne(newReturn)
    } catch(err) {
        console.log('Save return data error:' + err.message)
    }
    return newReturn
} 

async function getReturns() {
    const returns = []
    try {
        const query = await returnsCollection.find().limit(50).sort({date: -1}).toArray()
        for (const curReturn of query) {
            const fromOrder = await ordersCollection.findOne({number: curReturn.order})
            let invoice = ''
            if (fromOrder !== null ) invoice = fromOrder.invoice_number
            const returnOrder = await ordersCollection.findOne({
                vyrizeno: 'f', 
                invoice_note: 'Opravný daňový doklad k faktuře č. ' + invoice,
                //"total_per_vat['21'].price_with_vat": curReturn.totalSum,
            })
            
            let vs =''
            if (returnOrder !== null ) {
                //console.log(returnOrder.total_per_vat['21'].price_with_vat, curReturn.totalSum)
                vs = returnOrder.invoice_variable_symbol
            }
            returns.push({
                ...curReturn,
                invoice,
                vs
            })
        }
    } catch(err) {
        console.log('Get returns data error:' + err.message)
    }
    return {returns}
} 

async function saveSale(items, storeID) {
    const fs= require('fs')
   
    //action prepare
    if (storeID == 'Outlet') {
        let actionReducer = 0.7
        //actionReducerShoes = 0.9
        //const notInAction = []
        /*
        let inAction= []
        try {
            inAction = fs.readFileSync(__dirname +'art_action.txt', {encoding: 'utf8'}).split('\n')
        } catch(err) {console.log(err.message)}
        let actionIndexes = []
        */
        //let actionIndexesShoes = []
        items.forEach((item, index) => {
            let actionItem = false
            //let actionItemShoes = false
            /*/apparel
            if (item.productId.length > 7) {  //|| inAction.find(i=> i == item.productId) !== undefined)
                if (item.productId[1] > 7) { //FW21
                    actionItem = true 
                }
            //shoes
            } else { 
                actionItem = true
                //  if (item.productId[0] == 7 && item.productType === 'Sandály') actionItemShoes = true
            }
            */
            //if (item.productId.length == 7 && item.productId[0] == 1) { actionItem = false }
            if (item.productId.length == 7 && item.productId[0] == 7) {
                //if (inAction.includes(item.productId)) {actionReducer= 0.7}
                actionItem = true 
            }
            if (actionItem && item.count > 0) actionIndexes.push(index)
            //if (actionItemShoes && item.count>0) actionIndexesShoes.push(index)
        })
        //if (actionIndexes.length > 2) 
        actionIndexes.forEach(index => {items[index].storePrice = Math.round(items[index].storePrice * actionReducer)
            console.log(items[index].productId, ' ', items[index].storePrice)
        })
        //actionIndexesShoes.forEach(index => items[index].storePrice = Math.round(items[index].storePrice * actionReducerShoes))
    }

    let date = new Date().toISOString().slice(0,10)
    let newSale
    try {
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
                total: item.count*Math.abs(item.storePrice),
                orderPrice: item.price,
            })
            totalSum = totalSum + item.count*Math.abs(item.storePrice)
            totalCount = totalCount + item.count
            totalPriceDif  = totalPriceDif + item.price - item.storePrice
        })
        newSale = { date, totalSum, totalCount, totalPriceDif, storeID, items: itemsList }
        await salesCollection.insertOne(newSale)

        //reduce items count in variants
        for (let i=0; i<newSale.items.length; i++) {
            let {productId, size, count} = items[i]
            let result = await inventoryCollection.findOneAndUpdate(
                { model: productId, size, "inventory.id": storeID},
                { $inc: {"inventory.$.quantity": -1}}
            )
        }

        //update 'saved' status at returns
        for (let i=0; i<returnsIndexes.length; i++) {
            let item = items[returnsIndexes[i]]
            await returnsCollection.updateOne({
                    order: item.orderNumber, 
                    items: {$elemMatch: { productId: item.productId, size: item.size }}},
                { 
                    $set: { "items.$.saved" : true, "items.$.saveDate": date }})
        }
    } catch(err) {
        console.log('Save sale data error:' + err.message)
    }
    return newSale
} 

async function getSales(storeID, date) {
    let sales = []
    let daySalesTotal = 0
    try {
        sales = await salesCollection.find({ date: date, storeID: storeID}).toArray()
        if (sales.length > 0) sales.forEach(sale => {daySalesTotal = daySalesTotal + sale.totalSum})
    } catch(err) {
        console.log('Get sales data error:' + err.message)
    }
    return {salesData : sales, daySales: daySalesTotal, date, id: storeID }
} 

async function getOrdersByItem (item) {
    let orders = []
    try {
        let itemID, variant
        if (item.length == 13 && !item.includes(' ')) {
            const ean = parseInt(item)
            variant = await inventoryCollection.findOne({ean})
        } else {
            const [model, size]= item.split(' ')
            variant = await inventoryCollection.findOne({ model, size })
        }
        if (variant) {
            variant.esVarId ? itemID= variant.esVarId : itemID= variant["_id"]
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
            await ordersCollection.find(dbQuery, dbOptions).forEach(order => {
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
    }
    return { orders }
} 

async function getItem (item) {
    let searchedItem = null
    try {
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
    }
    return searchedItem
}

var ordersCollection, inventoryCollection, salesCollection, returnsCollection

function init (mongoUri) {
    const mongoClient = new MongoClient(mongoUri, { useUnifiedTopology: true })
    if (mongoClient.isConnected() === false) {
        mongoClient.connect().then(() => {
            console.log('Connected to DB')
            const db = mongoClient.db('pmg')
            ordersCollection = db.collection('orders')
            inventoryCollection = db.collection('variants')
            salesCollection = db.collection('sales')
            returnsCollection = db.collection('returns')
        })
    }
    return {
        getOrdersData, saveSale, saveReturn, getReturns, getSales, getOrdersByItem, getOrder, getItem
    }
}

module.exports = { init }

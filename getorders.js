const { MongoClient, ObjectId } = require('mongodb')

const actionArts = [];
const actionArtsOther = [];

//append legacy order state to the order object
function legacyApi(orders) {
    const newStates = {
        13495 : "n",
        13498 : "c",
        13499 : "d",
        13500 : "e",
        13497 : "b",
        13502 : "g",
        13503 : "h",
        13496 : "a",
        221 : 1,
        13501 : "f",
    }
    let noErrors = true
    let ordersCounter = orders.length - 1
    while (ordersCounter >= 0 && noErrors) {
        const order = orders[ordersCounter]
        const newState = order["id_order_state"]
        const oldState = newStates[newState]
        if (oldState !== undefined) {
            orders[ordersCounter] = { ...order, "vyrizeno": oldState}
        } else {
            noErrors = false
            console.log(` Order ${order["id_order"]} has unknown state ${newState}`)
        }
        ordersCounter--
    }
    if (!noErrors) {
        return []
    }
    return orders
}

//configurable orders read with ER api
function getApiOrders (url, limit, date, after ) {
    return new Promise((resolve, reject) => {
        let addToUrl = '';
        if (limit) addToUrl = addToUrl + '&limit=' + limit
        let direction
        after ? direction =  '&after=' : direction =  '&before='
        if (date) addToUrl = addToUrl + direction + Math.round(new Date(date).getTime()/1000)
        fetch(url + addToUrl)
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                console.log(` Loaded from API ${data.params.orderList.length} orders`)
                resolve (legacyApi(data.params.orderList))
            } else {
                reject(new Error('Failed to load from API'))
            }
          })
        .catch (err => {
            reject(err);
            console.log(err.message);
        })
    })
}

async function getOrdersData(eshopUri) {
    let ordersList= []
    let productList= []
    let ordersToReturn = []
    let productIndex= 0
    const workStatus = ['c','d','n','g']
    //loading action articles
    try {
        const loadedArts = await Bun.s3.file("actionarts").text()
        actionArts.length = 0
        actionArts.push(...loadedArts.split(/\r?\n/).filter(line => line.trim() !== ''))
        const loadedArtsOther = await Bun.s3.file("actionarts40").text()
        actionArtsOther.length = 0
        actionArtsOther.push(...loadedArtsOther.split(/\r?\n/).filter(line => line.trim() !== ''))
        console.log(` Loaded ${actionArts.length} action arts & ${actionArtsOther.length} other action arts`)
    } catch(err) {
        console.log('Problem with loading action arts data')
        console.error(err)
    }
    //add fresh and update new, paid and unpaid orders
    try {
        console.log(' Getting orders from DB');
        const ordersToUpdate = await ordersCollection.find(
            { vyrizeno : { $in: workStatus } }, 
            { sort: {'id_order': -1}, projection: { '_id': 0, 'id_order': 1, 'vyrizeno': 1}})
            .toArray();

        const lastDbOrder = await ordersCollection.findOne({}, {sort: {id_order: -1}, projection: { '_id': 0, 'id_order': 1}});
        const lastDbOrderId = lastDbOrder.id_order;
        console.log(' done');

        let lastApiOrderId = lastDbOrderId;
        console.log(' Getting orders from API');
        let apiOrders = [];
        try {
            apiOrders = await getApiOrders(eshopUri, 99);
            lastApiOrderId = apiOrders[0].id_order;
        } catch {
            console.log('Problem with ESR API');
        };
        console.log(' done');

        let firstOrderToUpdate = lastDbOrder;
        if (ordersToUpdate.length > 0) { firstOrderToUpdate = ordersToUpdate[ordersToUpdate.length - 1].id_order };
        let ordersCount = lastApiOrderId - firstOrderToUpdate + 1;
        if (ordersCount > 99) { ordersCount = 99 }; //TODO implement page read from api
        let newOrdersCount = lastApiOrderId - lastDbOrderId
        if (newOrdersCount > 99) newOrdersCount = 99 //TODO implement page read from api
        
        const freshApiOrders = apiOrders.slice(0, newOrdersCount);
        if (freshApiOrders.length > 0) {
            let result = await ordersCollection.insertMany(freshApiOrders);
            result ? console.log(` ${result.insertedCount} fresh orders inserted`) : console.log(` 0 fresh orders from ${newOrdersCount} inserted`);
        };

        let updatedOrders = 0;
        for (let i = 0; i < ordersToUpdate.length; i++) {
            let orderIdToUpdate = ordersToUpdate[i]['id_order']
            let orderIndex = apiOrders.findIndex(e => e['id_order'] === orderIdToUpdate)
            if (orderIndex !== -1) {
                const newStatus = apiOrders[orderIndex]['vyrizeno']
                const prevStatus = ordersToUpdate[i]['vyrizeno']
                if (!workStatus.includes(newStatus) && workStatus.includes(prevStatus)) { ordersToReturn.push({id_order: orderIdToUpdate, newStatus, prevStatus})}
                let result = await ordersCollection.replaceOne(
                    { 'id_order' : apiOrders[orderIndex]['id_order'] }, apiOrders[orderIndex])
                if (result.modifiedCount === 1) updatedOrders++
            }
        };
        console.log(` ${updatedOrders} orders updated from ${ordersToUpdate.length}`)
        
        let loopCounter = 1
        let lastLoop = false
        while (!lastLoop){

            //read and process new, paid and unpaid orders
            const dbQuery = { vyrizeno : { $in: workStatus} }
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
                if (order.delivery.nazev_postovne === "Osobní odběr" 
                    && order.payment.nazev_platba.startsWith('Hotově')) {
                        status = 'Ne'
                        toSend = true
                }
                if (order.payment.nazev_platba == "Platba dobírkou" || status=='Ano') toSend = true
                let phone = order.customer.delivery_information.phone
                let psc = order.customer.delivery_information.zip
                
                //finding SK orders
                let skOrder = ''
                if ( ['0','8','9'].includes(psc[0]) ) skOrder = '?'
                if (phone.slice(phone.length - 9, phone.length - 8) == "9") skOrder = '?'
                const deliveryService= order.delivery.nazev_postovne.split(' - ')[0]
                const slDelivery = ['GLS Slovensko', 'GLS ParcelShop Slovensko', 'PPL Slovensko', 'Zásilkovna Slovensko', 'DPD Slovensko']
                if (slDelivery.includes(deliveryService)) skOrder = '!'
                const currency = order.selected_currency.code;
                const exchangeRate = order.selected_currency.exchangeRate;
                if (currency === 'EUR' && (order.total_per_vat['23'] !== undefined || order.total_per_vat[0] !== undefined)) { skOrder = '+' };

                //Collect PPL data
                const deliveryType = order.delivery.nazev_postovne;
                const isPoint = deliveryType.startsWith('GLS Výdejní místa');
                let pointID = '';
                if (isPoint) {
                    const pointNameStart = deliveryType.indexOf('(');
                    const pointName = deliveryType.slice(pointNameStart + 1, deliveryType.length - 1);
                    if (pointName.length > 0 && pointNameStart !== -1) {
                        const pointIDStart = pointName.indexOf('[');
                        if (pointIDStart !== -1) {
                            pointID = pointName.slice(pointIDStart + 1, pointName.length - 1);
                        } else {
                            //looking for pointID at DB
                            const point = await glsPoints.findOne({ 'Name': pointName });
                            if (point && point.ID) { 
                                pointID = point.ID 
                            } else {
                                //TODO refresh GLS points collections
                                console.log(`PointID not found for ${pointName} order ${order.id_order}`)
                            }
                        }
                    } else { console.log (`Problem with decoding point name from ${deliveryType}`)}
                };
                const services = isPoint ? 'PSD(' + pointID + ')' : '';
		        const ulice = order.customer.delivery_information.street.replace(',', ' ');
                const jmeno = order.customer.delivery_information.name;
                if (phone.length !== 9) {
                    phone = phone.slice(phone.length - 9, phone.length)
                };
                let dobirka = ''
                if (order.payment.nazev_platba == "Platba dobírkou") {
                    dobirka = order.total.price_with_vat;
                    if (currency === 'EUR') { 
                        const mainPart = Math.round(dobirka * exchangeRate * 100) / 100;
                        const ending = Math.round(dobirka * exchangeRate * 100) % 10;
                        let increment = 0;
                        if (ending > 0 && ending <= 5) { increment = 0.05 - ending / 100 }
                        if (ending > 0 && ending > 5) { increment = 0.1 - ending / 100 }
                        dobirka = mainPart + increment;
                    }
                }
                let pplData = {
                    'vs': order.number,
                    'poznamka': order.customer.delivery_information.note,
                    jmeno,
                    'telefon': phone,
                    'zeme': skOrder === '' ? 'CZ' : 'SK',
                    'email': order.customer.delivery_information.email,
                    ulice,
                    'mesto': order.customer.delivery_information.city,
                    psc,
                    dobirka,
                    services,
                }
                
                //productlist + assign stores and action 'n' or 'u'
                for (i=order.row_list.length -1; i >= 0; i--) {
                    const product = order.row_list[i]
                    let productId = product.product_number
                    let isSolomio = false;
                    const isAction = ['58'].includes(productId.slice(0,2)) && actionArts.includes(productId + "");
                    //size transform
                    let sizeParts = product.variant_description.split(' ')
                    let size = sizeParts[2] ? sizeParts[2] : "";
                    if (sizeParts[3] !== undefined) { size += ' ' + sizeParts[3] };
                    if (sizeParts[2] === "zima") { 
                        size = sizeParts[3];
                        if (size[1] == "+") { size = size[0] }
                    };
                    if (['-', '/'].includes(size[2]) && productId.length === 8 && ['56','57'].includes(productId.slice(0,2))) {
                        size = size[2] === '-' ? size.split('-')[0] + '/' : size.slice(0,3);
                    };
                    if (size === '6R+') { size = '6/A'};
                    if (size === '4R+') { size = '4/6'};
                    if (size === '9M+') { size = '9/M' };
                    if (size === '18M+' || size === '24M+') { size = size.slice(0,2) + '/' };
                    if (["8/9R", "6/7R", "4/5R", "10/11R", "1/3 M", "6/9 M", "12/13R"].includes(size)) { size = size.slice(0,3) };
                    if (size[2] === '-') { size = size.slice(0,2) + '/' };
                    if (['56','79','78'].includes(productId.slice(0,2)) && ["4","5"].includes(size)) {
                        const stock = await inventoryCollection.findOne({
                            model: productId,
                            size,
                        });
                        if (stock === null) { size += 'A' }; 
                    };
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
                        let storeID = "Nejsou"
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
                                if (item.orderId === order.number && item.productId === productId && item.size === size && item.count > 0) {
                                    soldItems.push({storeID: sale.storeID, date: sale.date, price: item.price})
                                }
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
                                            if (stock.inventory[i].isSolomio) { isSolomio = true };
                                        } else { itemQuantity = itemQuantity - stock.inventory[i].quantity}
                                    }
                                    i++
                                }
                            } else {
                                storeID = "Nové";
                            }
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
                            pic: productId.split(" ").join("-"),
                            isSolomio,
                            isAction,
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
                    missingItem: false,
                    skOrder,
                    allItemSold: true,
                })
            }
            
            //define sender and order status
            productList.forEach(item => {
                const orderIndex = ordersList.findIndex(order => order.number == item.orderNumber);
                const sender = item.storeID === 'Kotva' ? 'Harfa' : item.storeID;
                ordersList[orderIndex].missingItem = ordersList[orderIndex].missingItem || item.storeID === 'Nejsou';
                if (ordersList[orderIndex].sender === '') { 
                    ordersList[orderIndex].sender = sender 
                };
                if (sender !== 'Nejsou' && ordersList[orderIndex].sender !== 'Mix' && ordersList[orderIndex].sender !== sender) {
                    ordersList[orderIndex].sender = 'Mix';
                };
                if (ordersList[orderIndex].allItemSold && item.date == '') { ordersList[orderIndex].allItemSold = false };
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
                            pic: item.productId.split(" ").join("-"),
                        })
                        productIndex++
                    }
                })
            })

            //orders status return
            let returnedOrders = 0
            let approvedOrders = 0
            console.log(` Orders to return: ${ordersToReturn.length}, orders to view: ${ordersList.length}`)
            for (let i=0; i<ordersToReturn.length; i++) {
                const { id_order, newStatus, prevStatus } = ordersToReturn[i]
                const orderListItem = ordersList.find(e => e.id == id_order)
                let returnOldStatus = true
                if (orderListItem && orderListItem.allItemSold) { returnOldStatus = false } //on first loop every updated orders ain't at ordersList, so status will return to previous 
                if (newStatus == "e") { returnOldStatus = false } //TODO implement canceled orders logic
                if (returnOldStatus) {
                    const result = await ordersCollection.updateOne(
                        { id_order }, {$set : {vyrizeno: prevStatus}})
                        if (result) returnedOrders++
                    else console.log("ret",id_order, prevStatus, newStatus)
                } else {
                    if (loopCounter !== 1) {
                        const result = await ordersCollection.updateOne(
                            { id_order }, {$set : {vyrizeno: newStatus}})
                        if (result.modifiedCount === 1) approvedOrders++
                        else console.log("app",id_order, prevStatus, newStatus)
                    }
                }
            }
            console.log(` ${returnedOrders} orders status returned and ${approvedOrders} don't from ${ordersToReturn.length}`)
            if (returnedOrders === 0 && approvedOrders === 0 || loopCounter > 2) { lastLoop = true }
            if (loopCounter === 2) { ordersToReturn = [] }
            if (!lastLoop) {
                ordersList = []
                productList = []
            }
            loopCounter++
        }

    } catch(err) {
        console.log(err)
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
            let size = product.variant_description.split(' ')[2]
            if (size === "zima") { size = product.variant_description.split(' ')[3]}
            items.push({
                orderId: order.id_order,
                orderNumber: order.number,
                productType: product.product_name,
                productId: product.product_number,
                size,
                price: product.price_total_with_vat,
                count: product.count,
            })
        })
        for (i = 0; i < items.length; i++) {
            let product = items[i];
            let storeID = 'Nejsou';
            let storePrice = 0;
            let soldDate = '';
            let user = '';
            let size = product.size ? product.size + "" : "";
            if (product.productId.startsWith('56') && ["4","5"].includes(size)) { size += 'A' };
            if (['-', '/'].includes(size[2]) && product.productId.length === 8 && ['56','57'].includes(product.productId.slice(0,2))) {
                size = size[2] === '-' ? size.split('-')[0] + '/' : size.slice(0,3);
            };
            if (size === '6R+') { size = '6/A'};
            if (size === '4R+') { size = '4/6'};
            if (size === '9M+') { size = '9/M' };
            if (size === '18M+' || size === '24M+') { size = size.slice(0,2) + '/' };
            if (["8/9R", "6/7R", "4/5R", "10/11R", "1/3 M", "6/9 M", "12/13R"].includes(size)) { size = size.slice(0,3) };
            if (size[2] === '-') { size = size.slice(0,2) + '/' };
            let stock = await inventoryCollection.findOne({
                model: product.productId,
                size,
            });
            if (!stock && ['79','78'].includes(product.productId.slice(0,2))) {
                size += 'A';
                stock = await inventoryCollection.findOne({
                    model: product.productId,
                    size,
                });
            };
            if (stock) {
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
            } else { storeID = "Nové" };
            let query = {
                    items: {$elemMatch: { 
                        orderId: product.orderNumber, 
                        productId: product.productId,
                        size,
                        count: { $gt: 0 },
                    }}
                };
            if (product.count < 0) { 
                query = {
                    items: {$elemMatch: { 
                        productId: product.productId,
                        size,
                        count: {$lt: 0},
                    }}
                }
            };
            let sold = await salesCollection.findOne(query);
            if (sold !== null) {
                soldItem = sold.items.find(e => (e.productId === product.productId && e.size === size ))
                storeID = sold.storeID
                storePrice = soldItem.price
                soldDate = sold.date
                user = sold.user
            }
            items[i].storeID = storeID
            items[i].storePrice = storePrice
            items[i].date = soldDate
            items[i].user = user
        }
        orderData.items = items
    } catch(err) {
        console.log('Get order data error:' + err.message)
    }
    return orderData
} 

async function saveReturn(data) {
    const delivery = !data.delivery ? 0 : data.delivery * -1;
    const payment = !data.payment ? 0 : data.payment * -1;
    const date = new Date().toISOString().slice(0,10);
    let newReturn = {
        ...data,
        delivery,
        payment,
        date,
        totalSum: delivery + payment,
        totalPriceDif: 0,
        totalCount: 0,
        datePay: '',
        items: [],
    };
    data.items.forEach(item => {
        let itemCount = item.count;
        item.price = Math.round(item.price * -1 / item.count);
        item.storePrice *= -1;
        item.count = -1;
        item.saved = false;
        while (itemCount > 0) {
            newReturn.totalSum += item.price;
            newReturn.totalPriceDif += item.price - item.storePrice;
            newReturn.totalCount--;
            newReturn.items.push(item);
            itemCount--;
        };
    });
    try {
        await returnsCollection.insertOne(newReturn)
    } catch(err) {
        console.log('Save return data error:' + err.message)
    };
    return newReturn;
};

async function getReturns(command) {
    const returns = []
    try {
        const query = await returnsCollection.find().limit(100).sort({date: -1}).toArray()
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

    if (command) {
        const woPays = returns.filter(item => item.vs && item.datePay === '')

        if (command === "paid") {
            const date = new Date().toISOString().slice(0,10);
            for (const item of woPays) {
                await returnsCollection.updateOne({_id: new ObjectId( item._id )}, { $set: { datePay: date }})
            };
        }

        if (command === "card") {
            const pGateData = await Bun.s3.file("cardtrans.csv").text()
            const pGateLines = pGateData.split(/\r?\n/).filter(line => line.trim() !== '')
            const pGateRecords = pGateLines.map(line => {
                const [pGateId, esrOrderId] = line.split(';')
                return { pGateId, esrOrderId }
            })
            console.log(` Loaded ${pGateRecords.length} pGate records `)
            return woPays.map( item => {
                if (item.account.length > 0) { return item }
                const pGateRecord = pGateRecords.find(record => record.esrOrderId === item.order);
                if (pGateRecord) {
                    return { ...item, pGateId: pGateRecord.pGateId }
                } else {
                    return item
                }
            })
        }

        if (command === "abo") {
            return woPays.filter( item => item.account.length > 0 && item.bank.length > 0 )
        }

        return { returns: woPays };
    };

    return { returns }
} 

async function saveSale(items, storeID, activeUser) {
    
    async function saveSubSale (items, voucher = 0, toStore) {

        let saleSaved = false;
        const date = new Date().toISOString().slice(0,10);
        let totalSum = 0
        let totalCount = 0
        let totalPriceDif = 0
        let itemsList = []
        let returnsIndexes = []
        let transUser;
        items.forEach((item, index) => {
            if (item.count < 0) returnsIndexes.push(index)
            if (item.user) { transUser = item.user };
            const itemPriceForSale = (storeID === "Harfa" || toStore === "Harfa") ? item.price : item.storePrice; // for Harfa always use order's price otherwise BST price
            const realStorePrice = voucher === 0 ? itemPriceForSale : itemPriceForSale - voucher;
            itemsList.push({
                orderId: item.orderNumber,
                productId: item.productId,
                size: item.size,
                price: realStorePrice,
                count: item.count,
                total: item.count * Math.abs(realStorePrice),
                orderPrice: item.price,
            })
            totalSum += item.count * Math.abs(realStorePrice);
            totalCount += item.count;
            totalPriceDif += item.price - realStorePrice;
        })
        const saleAdd = voucher === 0 ? {} : {voucher};
        const time = new Date().toTimeString().slice(0,17);
        const user = transUser ? transUser : activeUser;
        const newSale = { date, time, user, totalSum, totalCount, totalPriceDif, storeID, items: itemsList, ...saleAdd };
        if (["Kotva", "Outlet", "Harfa"].includes(toStore) && toStore !== storeID) { 
            newSale.storeID = toStore;
            newSale.from = storeID;
        };
        const result = await salesCollection.insertOne(newSale);
        if (result) { 
            saleSaved = true;
            items.forEach(item => item.action = "u");
        };

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

       return saleSaved;
    };

    //action prepare
    if (false && ['Outlet'].includes(storeID)) {
        const moreActionItems = [];
        items.forEach((item, index) => {
            if (item.count > 0) {
                let actionReducer = 0.8;
                if (item.productId.length > 7) {
                //apparel
                    if (['52', '54', '56'].some(prefix => item.productId.startsWith(prefix)) || actionArts.includes(item.productId) || actionArtsOther.includes(item.productId)) {
                        actionReducer = 0.7
                    }
                //shoes
                } else {
                    if (/^[246]/.test(item.productId) && storeID === 'Kotva') { 
                        actionReducer = 0.5
                    }
                    if (/^[246]/.test(item.productId) && storeID === 'Outlet') { 
                        actionReducer = 0.7
                    }
                }
                items[index].storePrice = Math.round(items[index].storePrice * actionReducer)
            }
        })
    };
    
    let action = false;
    let actionItem;
    let itemsForSale = items.filter((e) => !e.isSolomio);
    let itemsForMove = items.filter((e) => e.isSolomio);
    let voucher = 0;
    
    //voucher action
    if (false) { //storeID === "Kotva") {
        if (items.length < 2) { return false };
        let totalSum = 0;
        let smallestValue = 0;
        let smallestIndex = -1;
        let totalCount = 0;
        items.forEach((item, index) => {
            if (item.storePrice > 0 && (item.storePrice < smallestValue || smallestValue === 0)) { 
                smallestValue = item.storePrice;
                smallestIndex = index;
            };
            totalSum += item.storePrice;
            totalCount += item.count;
        })
        if (smallestIndex === -1 || (totalCount !==0 && (totalSum - smallestValue) < 500)) { return false };
        voucher = Math.round((totalSum - smallestValue) * 0.2);
        if (totalCount > 0) {
            itemsForSale = [];
            action = true;
            actionItem = items[smallestIndex];
            items.forEach((item, index) => { if (index !== smallestIndex) itemsForSale.push(item) });
        };
    }

    let saleSaved = false;
    try {
        saleSaved = itemsForSale.length === 0 ? true : await saveSubSale(itemsForSale);
        //console.log(itemsForSale);
        if (saleSaved && action && actionItem) {
            const result = await saveSubSale([actionItem], voucher);
            //if (result) { actionItem.action = "u" };
        };
        if (saleSaved && itemsForMove.length > 0) {
            const result = await saveSubSale(itemsForMove, 0, "Harfa" );
        };
    } catch(err) {
        console.log('Save sale data error:' + err.message)
    }
    return saleSaved;
};

async function getSales(storeID, date) {
    let sales = [];
    let daySalesTotal = 0;
    let infoSales = 0;
    try {
        sales = await salesCollection.find({ date, storeID }).toArray()
        if (sales.length > 0) sales.forEach((sale) => {
            daySalesTotal += sale.totalSum;
            if (sale.user && sale.user === "info@primigistore.cz") { infoSales += sale.totalSum };
        })
        const movements = await salesCollection.find({ date: date, from: storeID}).toArray();
        if (movements.length > 0) { sales = sales.concat(movements)};
    } catch(err) {
        console.log('Get sales data error:' + err.message)
    }
    return {salesData : sales, daySales: daySalesTotal, date, id: storeID, infoSales }
} 

async function getEan(id) {
    const salesData = [];
    try {
        const sale = await salesCollection.findOne({ _id: new ObjectId(id) });
        if (sale) { 
            const newItems = [];
            const { items } = sale;
            for (i = 0; i < items.length; i++) {
                const { productId, size } = items[i];
                const variant = await inventoryCollection.findOne({ prodId: productId, size });
                newItems.push({...items[i], ean: variant ? variant.ean : 0 });
            };
            salesData.push({ items: newItems }) 
        };
    } catch(err) {
        console.log('Get sales data error:' + err.message)
    };
    return { salesData }
}; 

async function getOrdersByItem (item) {
    let orders = []
    try {
        let itemID, variant
        if (item.length == 13 && !item.includes('*')) {
            const ean = parseInt(item)
            variant = await inventoryCollection.findOne({ean})
        } else {
            const [model, size]= item.split('*')
            variant = await inventoryCollection.findOne({ model: model, size })
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
                    "h": "Vyzvednutá",
                    1: "Nepřevzatá",
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
        if (item.length === 13 && !item.includes('*')) {
            const ean = parseInt(item, 10)
            searchedItem = await inventoryCollection.findOne({ ean: ean })
        } else {
            const [model, size] = item.split('*');
            searchedItem = await inventoryCollection.findOne({ model, size });
        }
    } catch(err) {
        console.log('Get item data error:' + err.message)
    }
    return searchedItem
}

var ordersCollection, inventoryCollection, salesCollection, returnsCollection, glsPoints

function init (mongoUri) {
    const mongoClient = new MongoClient(mongoUri)
    mongoClient.connect().then(() => {
        console.log('Connected to DB')
        const db = mongoClient.db('pmg')
        ordersCollection = db.collection('orders')
        inventoryCollection = db.collection('variants')
        salesCollection = db.collection('sales')
        returnsCollection = db.collection('returns')
        glsPoints = mongoClient.db('gls').collection('points');
    })
    return {
        getOrdersData, saveSale, saveReturn, getReturns, getSales, getOrdersByItem, getOrder, getItem, getEan,
    }
}

module.exports = { init }

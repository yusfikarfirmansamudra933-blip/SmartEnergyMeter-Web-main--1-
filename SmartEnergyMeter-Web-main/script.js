/*==========================================================
    SMART ENERGY METER
    Industrial Dashboard v2.0
==========================================================*/

'use strict';

//==========================================================
// DOM
//==========================================================

const voltageEl = document.getElementById("voltage");
const currentEl = document.getElementById("current");
const powerEl = document.getElementById("power");
const energyEl = document.getElementById("energy");
const frequencyEl = document.getElementById("frequency");
const pfEl = document.getElementById("pf");

const vaEl = document.getElementById("va");
const varEl = document.getElementById("var");

const percentEl = document.getElementById("percent");

const gaugeValue = document.getElementById("gaugeValue");
const gaugeCircle = document.getElementById("powerGauge");

const wifiLed = document.getElementById("wifiLed");
const wifiText = document.getElementById("wifiText");

const pzemStatus = document.getElementById("pzemStatus");

const limitInput = document.getElementById("limitInput");

let socket;

//==========================================================
// LIVE DATA
//==========================================================

let meter = {

    voltage:0,

    current:0,

    power:0,

    energy:0,

    frequency:0,

    pf:0,

    va:0,

    var:0,

    wifi:false,

    sensor:false,

    trip:false,

    limit:700

};

//==========================================================
// CHART
//==========================================================

let chart;

const chartLabels=[];

const powerDataset=[];

const voltageDataset=[];

const currentDataset=[];

//==========================================================

function createChart(){

const ctx=document
.getElementById("powerChart")
.getContext("2d");

chart=new Chart(ctx,{

type:"line",

data:{

labels:chartLabels,

datasets:[

{

label:"Power",

data:powerDataset,

borderWidth:3,

tension:.35,

fill:false

},

{

label:"Voltage",

data:voltageDataset,

borderWidth:2,

tension:.35,

fill:false

},

{

label:"Current",

data:currentDataset,

borderWidth:2,

tension:.35,

fill:false

}

]

},

options:{

responsive:true,

animation:false,

interaction:{

mode:'index',

intersect:false

},

plugins:{

legend:{

display:true

}

},

scales:{

x:{

display:true

},

y:{

beginAtZero:true

}

}

}

});

}

//==========================================================

function addChartData(){

const now=new Date();

chartLabels.push(

now.toLocaleTimeString()

);

powerDataset.push(

meter.power

);

voltageDataset.push(

meter.voltage

);

currentDataset.push(

meter.current

);

if(chartLabels.length>40){

chartLabels.shift();

powerDataset.shift();

voltageDataset.shift();

currentDataset.shift();

}

chart.update();

}

//==========================================================
// GAUGE
//==========================================================

const radius=100;

const circumference=

2*Math.PI*radius;

gaugeCircle.style.strokeDasharray=

circumference;

//==========================================================

function updateGauge(value){

let percent=

(value/meter.limit)*100;

if(percent<0)
percent=0;

if(percent>100)
percent=100;

const offset=

circumference-

(percent/100)*circumference;

gaugeCircle.style.strokeDashoffset=

offset;

if(percent<60){

gaugeCircle.style.stroke="#10B981";

}

else if(percent<85){

gaugeCircle.style.stroke="#F59E0B";

}

else{

gaugeCircle.style.stroke="#EF4444";

}

gaugeValue.innerHTML=

value.toFixed(0)+" W";

percentEl.innerHTML=

percent.toFixed(0)+"%";

}
function connectLegacyMQTT(){

    console.log("=== MQTT START ===");
    console.log("Broker:", MQTT_HOST);

    if(client){

        try{
            client.end(true);
        }
        catch(e){
            console.log("Old MQTT client closed");
        }

    }

    client = mqtt.connect(MQTT_HOST, {

        username: "",
        password: "",

        clientId:
            "SmartEnergyWeb_" +
            Math.random()
            .toString(16)
            .substring(2,10),

        clean: true,

        connectTimeout: 10000,

        reconnectPeriod: 3000

    });


    client.on("connect", function(){

        console.log("=== MQTT CONNECTED ===");

        wifiText.innerHTML = "ONLINE";

        client.subscribe(
            TOPIC_DATA,
            function(error){

                if(error){

                    console.error(
                        "SUBSCRIBE ERROR:",
                        error
                    );

                    return;
                }

                console.log(
                    "SUBSCRIBED:",
                    TOPIC_DATA
                );

            }
        );

    });


    client.on("message", function(topic, message){

        console.log(
            "MQTT MESSAGE:",
            topic,
            message.toString()
        );

        try{

            meter =
                JSON.parse(
                    message.toString()
                );
                
            saveMonthlyEnergy();

            connectionState.lastPacket =
                Date.now();

            updateDashboard();

            updateGauge(
                meter.power
            );

            console.log(
                "Dashboard updated"
            );

        }
        catch(error){

            console.error(
                "JSON ERROR:",
                error
            );

        }

    });


    client.on("error", function(error){

        console.error(
            "MQTT ERROR:",
            error
        );

        wifiText.innerHTML =
            "MQTT ERROR";

    });


    client.on("reconnect", function(){

        console.log(
            "MQTT RECONNECTING..."
        );

        wifiText.innerHTML =
            "RECONNECTING";

    });


    client.on("close", function(){

        console.log(
            "MQTT CLOSED"
        );

        wifiText.innerHTML =
            "OFFLINE";

    });

}
//==========================================================
// UPDATE SEMUA CARD
//==========================================================
function animateNumber(element, value, digit = 1){

    if(!element)
        return;

    const start =
        parseFloat(element.innerHTML) || 0;

    const duration = 300;

    const startTime = performance.now();

    function step(now){

        const progress =
            Math.min(
                (now - startTime) / duration,
                1
            );

        const current =
            start +
            (value - start) * progress;

        element.innerHTML =
            current.toFixed(digit);

        if(progress < 1){

            requestAnimationFrame(step);

        }

    }

    requestAnimationFrame(step);
}
//==========================================================
// RIWAYAT ENERGI BULANAN
//==========================================================

function saveMonthlyEnergy()
{
    if (
        typeof meter.energy !== "number" ||
        isNaN(meter.energy)
    ) {
        return;
    }

    const now = new Date();

    const year =
        now.getFullYear();

    const month =
        String(
            now.getMonth() + 1
        ).padStart(2, "0");

    const monthKey =
        year + "-" + month;


    // Ambil data histori
    let history =
        JSON.parse(
            localStorage.getItem(
                "monthlyElectricity"
            )
        ) || {};


    // Energi awal bulan
    let startData =
        JSON.parse(
            localStorage.getItem(
                "monthlyEnergyStart"
            )
        ) || {};


    // Jika bulan ini belum mempunyai
    // titik awal energi
    if (
        startData[monthKey] === undefined
    ) {

        startData[monthKey] =
            meter.energy;

        localStorage.setItem(
            "monthlyEnergyStart",
            JSON.stringify(startData)
        );
    }


    const startEnergy =
        Number(
            startData[monthKey]
        );


    const currentEnergy =
        Number(
            meter.energy
        );


    let monthlyEnergy =
        currentEnergy -
        startEnergy;


    // Jika PZEM di-reset atau nilai
    // energi lebih kecil dari titik awal
    if (monthlyEnergy < 0) {

        startData[monthKey] =
            currentEnergy;

        monthlyEnergy = 0;


        localStorage.setItem(
            "monthlyEnergyStart",
            JSON.stringify(startData)
        );
    }


    history[monthKey] =
        monthlyEnergy;


    localStorage.setItem(
        "monthlyElectricity",
        JSON.stringify(history)
    );


    console.log(
        "ENERGI BULANAN:",
        monthKey,
        monthlyEnergy,
        "kWh"
    );
}
function connectWebSocket(){

    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))
        return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

    socket.onopen = () => {
        wifiText.textContent = "ONLINE";
        refreshStatus();
    };

    socket.onmessage = (event) => {
        try {
            meter = JSON.parse(event.data);
            saveMonthlyEnergy();
            connectionState.lastPacket = Date.now();
            updateDashboard();
            updateGauge(meter.power);
        } catch (error) {
            console.error("Status data is invalid:", error);
        }
    };

    socket.onerror = () => {
        wifiText.textContent = "CONNECTION ERROR";
    };

    socket.onclose = () => {
        wifiText.textContent = "OFFLINE";
        socket = null;
        window.setTimeout(connectWebSocket, 3000);
    };
}

function updateDashboard(){

    animateNumber(voltageEl, meter.voltage, 1);

    animateNumber(currentEl, meter.current, 2);

    animateNumber(powerEl, meter.power, 0);

    animateNumber(energyEl, meter.energy, 3);

    animateNumber(frequencyEl, meter.frequency, 1);

    animateNumber(pfEl, meter.pf, 2);

    animateNumber(vaEl, meter.va, 0);

    animateNumber(varEl, meter.var, 0);

    updateGauge(meter.power);

    updateSensor();

    updateWifi();

    syncLimitInput();

    checkTrip();

}

//==========================================================
// STATUS WIFI
//==========================================================

function updateWifi(){

    if(meter.wifi === true){

        wifiLed.style.background = "#10B981";
        wifiText.innerHTML = "ONLINE";

    }
    else{

        wifiLed.style.background = "#EF4444";
        wifiText.innerHTML = "OFFLINE";

    }

}

//==========================================================
// STATUS PZEM
//==========================================================

function updateSensor(){

    if(meter.sensor){

        pzemStatus.innerHTML="ONLINE";

        pzemStatus.style.color="#10B981";

    }

    else{

        pzemStatus.innerHTML="ERROR";

        pzemStatus.style.color="#EF4444";

    }

}

//==========================================================
// OVERLOAD ALARM
//==========================================================

let lastTrip=false;

function checkTrip(){

    if(meter.trip && !lastTrip){

        lastTrip=true;

        showAlarm();

    }

    if(!meter.trip){

        lastTrip=false;

    }

}

//==========================================================
// UPDATE CHART
//==========================================================

function realtimeLoop(){

    updateDashboard();

    addChartData();

    checkTrip();

}

//==========================================================
// LIVE CLOCK
//==========================================================

function updateClock(){

    const now=new Date();

    const jam=

    now.toLocaleTimeString();

    const el=

    document.getElementById("clock");

    if(el){

        el.innerHTML=jam;

    }

}

//==========================================================
// UPDATE SETIAP 1 DETIK
//==========================================================

setInterval(()=>{

    realtimeLoop();

    updateClock();

},1000);

//==========================================================
// START
//==========================================================

window.addEventListener("load",()=>{

    createChart();

    connectWebSocket();

});
/*==========================================================
    CONTROL & API
==========================================================*/

//==========================================================
// TOAST NOTIFICATION
//==========================================================

function showToast(message, success = true) {

    const toast = document.createElement("div");

    toast.className = "toast";

    if (!success)
        toast.classList.add("error");

    toast.innerHTML = message;

    document.body.appendChild(toast);

    setTimeout(() => {

        toast.classList.add("show");

    }, 50);

    setTimeout(() => {

        toast.classList.remove("show");

        setTimeout(() => {

            toast.remove();

        }, 400);

    }, 3000);

}

//==========================================================
// BUTTON LOADING
//==========================================================

function setButtonLoading(id, loading) {

    const btn = document.getElementById(id);

    if (!btn) return;

    if (loading) {

        btn.disabled = true;

        btn.dataset.text = btn.innerHTML;

        btn.innerHTML = "Loading...";

    }
    else {

        btn.disabled = false;

        btn.innerHTML = btn.dataset.text;

    }

}

//==========================================================
// SAVE LIMIT
//==========================================================

function saveLimit()
{
    let value = parseFloat(limitInput.value);

    if (isNaN(value))
    {
        showToast("Limit tidak valid", false);
        return;
    }

    if (value < 100 || value > 10000)
    {
        showToast("Limit harus 100 - 10000 Watt", false);
        return;
    }

    fetch(`/setLimit?value=${encodeURIComponent(value)}`)
        .then(response => {
            if (!response.ok) throw new Error("Limit could not be saved");
            showToast("Limit disimpan");
            return refreshStatus();
        })
        .catch(() => showToast("Gagal menyimpan limit", false));
}

//==========================================================
// RESTART ESP
//==========================================================

function restartESP()
{
    if (!confirm("Restart ESP32 ?"))
        return;

    fetch("/restart")
        .then(() => showToast("Perintah restart dikirim"))
        .catch(() => showToast("Gagal mengirim perintah restart", false));
}

//==========================================================
// FACTORY RESET
//==========================================================

function factoryReset()
{
    if (!confirm("Factory Reset ?"))
        return;

    fetch("/factoryReset")
        .then(() => showToast("Factory reset selesai"))
        .then(refreshStatus)
        .catch(() => showToast("Gagal melakukan factory reset", false));
}

//==========================================================
// REFRESH STATUS
//==========================================================

async function refreshStatus() {

    try {

        const res = await fetch("/api/status");

        if (!res.ok)
            return;

        meter = await res.json();

        updateDashboard();

    }

    catch {

        console.log("REST API Error");

    }

}

//==========================================================
// PAGE VISIBILITY
// Mengurangi penggunaan CPU saat tab tidak aktif
//==========================================================

let pageVisible = true;

document.addEventListener("visibilitychange", () => {

    pageVisible = !document.hidden;

});

//==========================================================
// AUTO SYNC LIMIT INPUT
//==========================================================

let lastLimit = -1;

function syncLimitInput(){

    if(lastLimit !== meter.limit){

        limitInput.value = meter.limit.toFixed(0);

        lastLimit = meter.limit;

    }

}

//==========================================================
// CONNECTION QUALITY
//==========================================================

const connectionState = {

    lastPacket : Date.now(),

    latency : 0

};

function updateConnection(){

    const now = Date.now();

    connectionState.latency =

    now - connectionState.lastPacket;

    const text = document.getElementById("connectionText");

    if(!text) return;

    if(connectionState.latency < 2000){

        text.innerHTML = "Excellent";

        text.style.color = "#10B981";

    }

    else if(connectionState.latency < 5000){

        text.innerHTML = "Good";

        text.style.color = "#F59E0B";

    }

    else{

        text.innerHTML = "Poor";

        text.style.color = "#EF4444";

    }

}

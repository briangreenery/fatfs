var S = require("./structs.js"),
    c = require("./chains.js"),
    _ = require("./helpers.js");

exports.init = function (volume, bootSector) {
    if (bootSector[510] !== 0x55 || bootSector[511] !== 0xAA) throw Error("Invalid volume signature!");
    
    var isFAT16 = bootSector.readUInt16LE(S.boot16.fields['FATSz16'].offset),
        bootStruct = (isFAT16) ? S.boot16 : S.boot32,
        BS = bootStruct.valueFromBytes(bootSector);
    bootSector = null;      // allow GC
    if (!BS.BytsPerSec) throw Error("This looks like an ExFAT volume! (unsupported)");
    
//console.log(BS);
    
    var FATSz = (isFAT16) ? BS.FATSz16 : BS.FATSz32,
        rootDirSectors = Math.ceil((BS.RootEntCnt * 32) / BS.BytsPerSec),
        firstDataSector = BS.ResvdSecCnt + (BS.NumFATs * FATSz) + rootDirSectors,
        totSec = (BS.TotSec16) ? BS.TotSec16 : BS.TotSec32,
        dataSec = totSec - firstDataSector,
        countofClusters = Math.floor(dataSec / BS.SecPerClus);
    // avoid corrupting sectors from other partitions or whatnot
    if (totSec > volume.totalSectors) throw Error("Volume size mismatch!");
    
    var fatType;
    if (countofClusters < 4085) {
        fatType = 'fat12';
    } else if (countofClusters < 65525) {
        fatType = 'fat16';
    } else {
        fatType = 'fat32';
    }
    
    //console.log("rootDirSectors", rootDirSectors, "firstDataSector", firstDataSector, "countofClusters", countofClusters, "=>", fatType);
    
    var vol = {};
    
    vol._sectorSize = BS.BytsPerSec;
    vol._sectorsPerCluster = BS.SecPerClus;
    vol._firstSectorOfCluster = function (n) {
        return firstDataSector + (n-2)*vol._sectorsPerCluster;
    };
    
    vol._readSector = function (secNum, cb) {
        var secSize = vol._sectorSize,
            sectorBuffer = new Buffer(secSize);
        volume.read(sectorBuffer, 0, secSize, secNum*secSize, function (e) {
            cb(e, sectorBuffer);
        });
    };
    
    vol._writeSector = function (secNum, data, cb) {
console.log("_writeSector of", data.length, "bytes to sector", secNum);
        var secSize = vol._sectorSize;
        // NOTE: these are internal assertions, public API will get proper `S.err`s
        if (data.length !== secSize) throw Error("Must write complete sector");
        else if (!volume.write) throw Error("Read-only filesystem");
        else volume.write(data, 0, secSize, secNum*secSize, cb);
    };
    
    function fatInfoForCluster(n) {
        var entryStruct = S.fatField[fatType],
            FATOffset = (fatType === 'fat12') ? Math.floor(n/2) * entryStruct.size : n * entryStruct.size,
            SecNum = BS.ResvdSecCnt + Math.floor(FATOffset / BS.BytsPerSec);
            EntOffset = FATOffset % BS.BytsPerSec;
        return {sector:SecNum-BS.ResvdSecCnt, offset:EntOffset, struct:entryStruct};
    }
    
    // TODO: all this FAT manipulation is crazy inefficient! needs read caching *and* write caching
    //        …the best place for cache might be in `volume` handler, though. add a `flush` method to that spec?
    // TODO: how should we handle redundant FATs? mirror every write? just ignore completely? copy-on-eject?
    
    var fatChain = c.sectorChain(vol, BS.ResvdSecCnt, FATSz);
    
    vol.fetchFromFAT = function (clusterNum, cb) {
        var info = fatInfoForCluster(clusterNum);
        fatChain.readFromPosition(info, info.struct.size, function (e,n,d) {
console.log("READ FROM FAT CHAIN", fatChain.toJSON(), info, e,n,d);
            if (e) return cb(e);
            var status = info.struct.valueFromBytes(d), prefix;
            if (fatType === 'fat12') {
                if (clusterNum % 2) {
                    status = (status.field0a << 8) + status.field0bc;
                } else {
                    status = (status.field1ab << 4) + status.field1c;
                }
            }
            else if (fatType === 'fat32') {
                status &= 0x0FFFFFFF;
            }
            
            var prefix = S.fatPrefix[fatType];
            if (status === S.fatStat.free) cb(null, 'free');
            else if (status === S.fatStat._undef) cb(null, '-invalid-');
            else if (status > prefix+S.fatStat.eofMin) cb(null, 'eof');
            else if (status === prefix+S.fatStat.bad) cb(null, 'bad');
            else if (status > prefix+S.fatStat.rsvMin) cb(null, 'reserved');
            else cb(null, status);
        });
    };
    
    vol.storeToFAT = function (clusterNum, status, cb) {
        if (typeof status === 'string') {
            status = S.fatStat[status];
            status += S.fatPrefix[fatType];
        }
        var info = fatInfoForCluster(clusterNum);
        // TODO: technically fat32 needs to *preserve* the high 4 bits
        if (fatType === 'fat12') fatChain.readFromPosition(info, info.struct.size, function (e,n,d) {
            var value = info.struct.valueFromBytes(d);
            if (clusterNum % 2) {
                value.field0a = status >>> 8;
                value.field0bc = status & 0xFF;
            } else {
                value.field1ab = status >>> 4;
                value.field1c = status & 0x0F;
            }
            var entry = info.struct.bytesFromValue(value);
            fatChain.writeToPosition(info, entry, cb);
        }); else {
            var entry = info.struct.bytesFromValue(status);
            fatChain.writeToPosition(info, entry, cb);
        }
    };
    
    vol.allocateInFAT = function (hint, cb) {
        if (typeof hint === 'function') {
            cb = hint;
            hint = 2;   // TODO: cache a better starting point?
        }
console.log("allocateInFAT", hint);
        function searchForFreeCluster(num, cb) {
            if (num < countofClusters) vol.fetchFromFAT(num, function (e, status) {
console.log("…at",num,"got:",status);
                if (e) cb(e);
                else if (status === 'free') cb(null, num);
                else searchForFreeCluster(num+1, cb);
            }); else cb(S.err.NOSPC());     // TODO: try searching backwards from hint…
        }
        searchForFreeCluster(hint, function (e, clusterNum) {
            if (e) cb(e);
            else vol.storeToFAT(clusterNum, 'eof', cb.bind(null,null,clusterNum));
        });
    };
    
    vol.rootDirectoryChain = (isFAT16) ?
        c.sectorChain(vol, firstDataSector - rootDirSectors, rootDirSectors) :
        c.clusterChain(vol, BS.RootClus);
    vol.chainForCluster = c.clusterChain.bind(c, vol);
    vol.chainFromJSON = function (d) {
        return ('numSectors' in d) ?
            c.sectorChain(vol, d.firstSector, d.numSectors) :
            c.clusterChain(vol, d.firstCluster);
    };
    
    return vol;
}
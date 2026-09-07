// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity ^0.8.24;

contract RiskTransitionVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 19786451258003612322559073033050759569094934746487782516682014912434396010215;
    uint256 constant alphay  = 21047689806392814970409682406973333926241436371992169398267288343916065296827;
    uint256 constant betax1  = 8973912977483370762413701220953161876356109972916816609422694150003437291043;
    uint256 constant betax2  = 2551760434415653382757844381007454938950739521961831035464678261156818655950;
    uint256 constant betay1  = 16544887672689657371180615310087646111568400838962008062362937862685314833327;
    uint256 constant betay2  = 1045338503092719705585279159119722006295555683778317314525907459118731993597;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant deltax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant deltay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant deltay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;

    
    uint256 constant IC0x = 3689175115290345805452690178893639696987104585998796404446080716937965768409;
    uint256 constant IC0y = 14513457777651504348099036683617029330119581675402552909854324567568443556650;
    
    uint256 constant IC1x = 9090927999879432614125871354826189286959163769120636062330746635816050532362;
    uint256 constant IC1y = 15882274211441911277356486809976677099515150656987651067065951061355034710450;
    
    uint256 constant IC2x = 9384882977313527448352090712849138170624330899642623410016086730619122198402;
    uint256 constant IC2y = 2912542631559853046300165592109651616767174215650421559798638986699946606914;
    
    uint256 constant IC3x = 9879254446029161543942039380784982907064789257691493242294975063769957838870;
    uint256 constant IC3y = 4799317429205483373191752680137314823636373968718169707826948127727423738059;
    
    uint256 constant IC4x = 13592313599362376949240528587170110934531046466822647317974737951333846718427;
    uint256 constant IC4y = 15369701166839633085840309328316761721521400351006553759405046262988966999713;
    
    uint256 constant IC5x = 17543964094483150896834267284941387338268440797032191112028331523837490669820;
    uint256 constant IC5y = 16590823771644376449896857505218981795576855006446618715707963498217544261089;
    
    uint256 constant IC6x = 15819328036632818504112828492232226478472563317932226710937928675427392517913;
    uint256 constant IC6y = 18489662053465192300467465754349595632029666741680734864610471906057464045100;
    
    uint256 constant IC7x = 16799664228694692866205861183604173022686790682075776560337731687330882734342;
    uint256 constant IC7y = 15578178516154862528823335561414453414482209160182517376359111558527822930459;
    
    uint256 constant IC8x = 2203408648584316834734587722195863490876264300391696199747806365592924162539;
    uint256 constant IC8y = 16027805130582726594690155591369607318886916720065234333939751044189554992819;
    
    uint256 constant IC9x = 12868894984922681959950578349702749217500650918803622512125204979106094831425;
    uint256 constant IC9y = 15835589563316074087026131866299458681954545570740328152019989223244479938810;
    
    uint256 constant IC10x = 11352643968404676109250292414710301672253370233199864826330414521057063447119;
    uint256 constant IC10y = 5060722972365338810921505776929390518310442337761198363901675322619906843930;
    
    uint256 constant IC11x = 12289428817245956356068942388218579705262311082057949474169141383491300691305;
    uint256 constant IC11y = 8216570905505887268441812118286233255080470625784012590100587158000874953783;
    
    uint256 constant IC12x = 16391398469556631929241745291822800212334824556024314882984659037489845267766;
    uint256 constant IC12y = 7307262800878071348292593926756423611426151769995332724396727611954048717867;
    
    uint256 constant IC13x = 21796902586523656075692310178766663581209362749006560445644261381372754170597;
    uint256 constant IC13y = 5048286819906387578451429776739578502220569027888833088832901494425052092108;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[13] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }

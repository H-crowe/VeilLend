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

    
    uint256 constant IC0x = 21868328054913761364184385205874831572640706800963845238620424741572237784229;
    uint256 constant IC0y = 10930311205000914325606515537184273381254573735273142134929501515233594456590;
    
    uint256 constant IC1x = 20194251547158571980206434310165695424784613488644610625276783534150052491061;
    uint256 constant IC1y = 10470916755570234075081111953111343216239487724013562316881629664332370255088;
    
    uint256 constant IC2x = 6172226724580769247145182234234965334424590018374691952714932263445398986887;
    uint256 constant IC2y = 18541886005482492360391052946917335025609136320018546105765757272389565285234;
    
    uint256 constant IC3x = 11364037882778444891314992894802338750576177096066263267629213342718569848330;
    uint256 constant IC3y = 17157945427286254608745855169635868063887300453633215228605612248103735351046;
    
    uint256 constant IC4x = 10242314974098633809809902418100365841524134602771576303382219638992426850285;
    uint256 constant IC4y = 4624793135639593992064210959243094418466397836449387204722179247632068995589;
    
    uint256 constant IC5x = 2425931405263719559585566008141023849055306148399763617568539637478534577004;
    uint256 constant IC5y = 582980321954548685568450222397736488521887560678576316882288391592084257955;
    
    uint256 constant IC6x = 8621077615618576928242584144039189808204778918070675837753749335516677590023;
    uint256 constant IC6y = 5543882079267393300875888481692346042874503102327411614495733943782946654698;
    
    uint256 constant IC7x = 4784131341068994262115243919737845252125851429653969671168334522902818011228;
    uint256 constant IC7y = 16965897327754262668284572810615366243608151087486707917381641689592941315912;
    
    uint256 constant IC8x = 114630673604244644701171947842492782266060327408242302473420178648803990165;
    uint256 constant IC8y = 19030114422554574924550638024528736225971579727151959751833937402048606614919;
    
    uint256 constant IC9x = 19809620300983068383288064034717491086750319625443188907415115841133112653811;
    uint256 constant IC9y = 16658482018841138369305356137390588439684571451679433319069322961736543993743;
    
    uint256 constant IC10x = 3204175371211661203672346370374611599996654032837093365619109550016048250059;
    uint256 constant IC10y = 2657848510800841501170973396243734840321356584150936408758576919100788170284;
    
    uint256 constant IC11x = 4986037694136860364514194924527360710354123665572727768238650500798166157749;
    uint256 constant IC11y = 21169467855548677547438365534547080580344926507544283035894461416775835442432;
    
    uint256 constant IC12x = 20291747016872117405633971179416871363334607984856691389250825175622334310664;
    uint256 constant IC12y = 13334545095435119119011491451070177781429863025286603748851090422680271861937;
    
    uint256 constant IC13x = 12999165157981356846671928419769004168428937591453745126592620677140232810254;
    uint256 constant IC13y = 5134523537933944871356814167181496372295258547549708454642949082599259690444;
    
 
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
